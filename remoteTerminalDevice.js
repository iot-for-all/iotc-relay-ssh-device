'use strict';

// Azure IoT Device SDK
const Protocol = require('azure-iot-device-mqtt').Mqtt;
const Client = require('azure-iot-device').Client;
const Message = require('azure-iot-device').Message;
const ExponentialBackOffWithJitter = require('azure-iot-common').ExponentialBackOffWithJitter;

// Azure IoT DPS SDK
const ProvisioningTransport = require('azure-iot-provisioning-device-mqtt').Mqtt;
const SymmetricKeySecurityClient = require('azure-iot-security-symmetric-key').SymmetricKeySecurityClient;
const ProvisioningDeviceClient = require('azure-iot-provisioning-device').ProvisioningDeviceClient;

// Crypto SDK needed for computing device keys
const crypto = require('crypto');

// device settings - FILL IN YOUR VALUES HERE
const deviceConfig = require('./deviceConfig.json');

const scopeId = deviceConfig && deviceConfig.scopeId;
const groupSymmetricKey = deviceConfig && deviceConfig.groupSymmetricKey;
const deviceId = deviceConfig && deviceConfig.deviceId || 'nodeRemoteTermDevice';
const modelId = deviceConfig && deviceConfig.modelId; 

// optional device settings - CHANGE IF DESIRED/NECESSARY
const provisioningHost = 'global.azure-devices-provisioning.net';

// test setting flags
const telemetrySendOn = true
const telemetrySendIntervalMs = 60000; // every minute
const reportedPropertySendOn = false
const propertySendIntervalMs = 360000; // every hour
const desiredPropertyReceiveOn = false
const directMethodReceiveOn = true
const c2dCommandReceiveOn = false

// relay service
const WebSocket = require('hyco-ws');
let relayServer;
let listenerConnectionString;

// SSH variables
const SSHClient = require('ssh2').Client;
let secrets = require('./sshConfig.json');
let host = secrets && secrets.host || getLocalIpAddress() || 'localhost';
let port = secrets && secrets.port || 22;  // SSH

// general purpose variables
let client = null;
let deviceTwin = null;
let connected = false;

const NEWLINE = ['\r', '\n'];

// calculate the device key using the symetric group key
function computeDerivedSymmetricKey(masterKey, deviceId) {
    return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64'))
        .update(deviceId, 'utf8')
        .digest('base64');
}


// Azure IoT Central custom retry policy derived from ExponentialBackOffWithJitter
class MultiHubRetryPolicy extends ExponentialBackOffWithJitter {
    constructor(...args) {
        super(...args);
    }

    shouldRetry(err) {
        if (err.message === 'Connection refused: Server unavailable') {
            return false; // if hub not available stop retry and fall back to DPS
        }

        return super.shouldRetry(err);
    }

    nextRetryTimeout(retryCount, throttled) {
        return super.nextRetryTimeout(retryCount, throttled);
    }
}


// handler for C2D message
async function messageHandler(msg) {
    const methodName = msg.properties.propertyList.find(o => o.key === 'method-name');

    if (methodName) {
        switch (methodName.value) {
            case 'setAlarm':
                console.log(`C2D method: ${methodName.value}(${msg.data.toString('utf-8')})`);

                await setAlarmCommandHandler(msg);
                break;

            default:
                console.log(`Unknown C2D method received: ${methodName.value}`);
        }
    }
}


// connect to IoT Central/Hub via Device Provisioning Servicee (DPS)
async function connect() {
    try {
        // calc device symmetric key from group symmetric key
        const deviceSymmetricKey = computeDerivedSymmetricKey(groupSymmetricKey, deviceId);

        // DPS provision with device symmetric key
        const provisioningSecurityClient = new SymmetricKeySecurityClient(deviceId, deviceSymmetricKey);
        const provisioningClient = ProvisioningDeviceClient.create(provisioningHost, scopeId, new ProvisioningTransport(), provisioningSecurityClient);

        // set the model to register against
        provisioningClient.setProvisioningPayload({
            iotcModelId: modelId
        });

        // register the device and get the hub host name
        const connectionString = await new Promise((resolve, reject) => {
            provisioningClient.register((dpsError, dpsResult) => {
                if (dpsError) {
                    console.log(`DPS register failed: ${JSON.stringify(dpsError, null, 4)}`);

                    return reject(dpsError);
                }

                console.log('registration succeeded');
                console.log(`assigned hub: ${dpsResult.assignedHub}`);
                console.log(`deviceId: ${dpsResult.deviceId}`);

                return resolve(`HostName=${dpsResult.assignedHub};DeviceId=${dpsResult.deviceId};SharedAccessKey=${deviceSymmetricKey}`);
            });
        });

        // create client from connection string
        client = Client.fromConnectionString(connectionString, Protocol);

        // cannot use the default retry logic built into the SDK as it will not fallback to DPS
        client.setRetryPolicy(new MultiHubRetryPolicy());

        // monitor for connects, disconnects, errors, and c2d messages
        client.on('connect', connectHandler);
        client.on('disconnect', disconnectHandler);
        client.on('error', errorHandler);

        if (c2dCommandReceiveOn) {
            client.on('message', messageHandler);
        }

        // connect to IoT Hub
        await client.open();

        // obtain twin object
        deviceTwin = await client.getTwin();

        if (desiredPropertyReceiveOn) {
            deviceTwin.on('properties.desired', desiredPropertyHandler);
        }

        // handlers for the direct method
        if (directMethodReceiveOn) {
            client.onDeviceMethod('echo', echoCommandDirectMethodHandler);
            client.onDeviceMethod('MSIoTCStartSSHSession', startRelayListenerCommandDirectMethodHandler);
            client.onDeviceMethod('MSIoTCStopSSHSession', stopRelayListenerCommandDirectMethodHandler);
        }
    }
    catch (err) {
        console.error(`Could not connect: ${err.message}`);
        throw new Error(`Hub connect error! Error: ${err.message}`);
    }
}


// handlef for connection event
function connectHandler() {
    console.log('Connected to IoT Central');
    connected = true;
}


// handler for disconnects, reconnect via DPS
async function disconnectHandler() {
    if (connected) {
        connected = false;
        console.log('Disconnected from IoT Central');

        await client.close()

        await connect();
    }
}


// handler for errors
function errorHandler(err) {
    console.log(`Error caught in error handler: ${err}`);
}


// sends telemetry on a set frequency
async function sendTelemetry() {
    if (connected) {
        const telemetry = {
            temp: (20 + (Math.random() * 100)).toFixed(2),
            humidity: (Math.random() * 100).toFixed(2)
        };

        const message = new Message(JSON.stringify(telemetry));

        await client.sendEvent(message, (err) => {
            if (err) {
                console.log(`Error: ${err.toString()}`);
            }
            else {
                console.log(`Completed telemetry send ${JSON.stringify(telemetry)}`);
            }
        });
    }
}

async function updateDeviceProperties(properties) {
    if (!deviceTwin) {
        return;
    }

    try {
        await new Promise((resolve, reject) => {
            deviceTwin.properties.reported.update(properties, (err) => {
                if (err) {
                    console.log(`Error: ${err.toString()}`);
                    return reject(err);
                }
                else {
                    console.log(`Completed property send ${JSON.stringify(properties)}`);
                    return resolve();
                }
            });
        });
    }
    catch (err) {
        console.log(`Error: ${err.message}`);
    }
}


// sends reported properties on a set frequency
async function sendReportedProperty() {
    if (connected) {
        const reportedPropertyPatch = {
            battery: (Math.random() * 100).toFixed(2)
        };

        await updateDeviceProperties(reportedPropertyPatch);
    }
}


// handles desired properties from IoT Central (or hub)
async function desiredPropertyHandler(patch) {
    if (Object.keys(patch).length > 1) {
        console.log(`Desired property received, the data in the desired properties patch is: ${JSON.stringify(patch)}`);

        // acknowledge the desired property back to IoT Central
        let key = Object.keys(patch)[0];
        if (key === '$version') {
            key = Object.keys(patch)[1];
        }

        const reported_payload = {};
        reported_payload[key] = {
            value: patch[key],
            ac: 200,
            ad: 'completed',
            av: patch['$version']
        };

        await updateDeviceProperties(reported_payload);
    }
}


// handles direct method 'echo' from IoT Central (or hub)
async function echoCommandDirectMethodHandler(request, response) {
    console.log(`Executing direct method request: ${request.methodName} "${request.payload}"`);

    try {
        // echos back the request payload
        await response.send(200, request.payload);
    }
    catch (err) {
        console.log(`Error in command response: ${err.message}`);
    }
}


async function startRelayListenerCommandDirectMethodHandler(request, response) {
    console.log(`Executing direct method request: ${request.methodName}`);
    const relayConnectionString = request.payload && request.payload.connectionString;
    if (!relayConnectionString) {
        const message = `Request payload does not contain connection string value. Cannot start remote terminal listener.`;
        console.log(message);
        await response.send(500, { listenerOn: false, error: message });
    } else if (relayServer && listenerConnectionString && listenerConnectionString !== relayConnectionString) {
        const message = `Connection string in request does not match the currently active listener's connection string.`;
        console.log(message);
        await response.send(500, { listenerOn: false, error: message });
    } else {

        try {
            // parse the connection string for its parts
            const { ns, path, keyrule, key } = getConnectionStringComponents(relayConnectionString);
            let invalidParts = [];
            if (!ns) invalidParts.push('ns');
            if (!path) invalidParts.push('path');
            if (!keyrule) invalidParts.push('keyrule');
            if (!key) invalidParts.push('key');
            
            if (invalidParts.length) {
                const message = `Invalid connection string. Missing component(s): ${invalidParts.join(', ')}`;
                console.log(message);
                await response.send(500, { listenerOn: false, error: message });
            } else {
                // start the listener
                relayServer = startRelayListener(ns, path, keyrule, key);
                console.log('Relay listener started');
                console.log(relayServer);
                listenerConnectionString = relayConnectionString;
                await response.send(200, { listenerOn: true });
            }

        } catch (err) {
            console.log(`Error in command response: ${err.message}`);
            await response.send(500, { listenerOn: false, error: err.message });
        }
    }
}

async function stopRelayListenerCommandDirectMethodHandler(request, response) {
    console.log(`Executing direct method request: ${request.methodName}`);
    if (!relayServer) {
        const message = `No active listener`;
        console.log(message);
        listenerConnectionString = undefined;
        await response.send(500, { listenerOn: false, error: message });
    } else {

        try {
            // parse the connection string for its parts
            relayServer.close();
            listenerConnectionString = undefined;
            relayServer = undefined;
            await response.send(200, { listenerOn: !!relayServer });

        } catch (err) {
            console.log(`Error in command response: ${err.message}`);
            await response.send(500, { listenerOn: !!relayServer, error: err.message });
        }
    }
}

function getConnectionStringComponents(connectionString) {
    let ns;
    let path;
    let keyrule;
    let key;
    if (connectionString) {
        const regEx = /^Endpoint=sb:\/\/(?<endpoint>\S+)\/;SharedAccessKeyName=(?<keyrule>\S+);SharedAccessKey=(?<key>\S+);EntityPath=(?<path>\S+)$/;
        const matches = connectionString.match(regEx);
        if (matches && matches.groups) {
            ns = matches.groups.endpoint;
            path = matches.groups.path;
            keyrule = matches.groups.keyrule;
            key = matches.groups.key;
        }
    }
    console.log(`Ns: ${ns}, path: ${path}, keyrule: ${keyrule}, key: ${key}`);
    return { ns, path, keyrule, key };
}

// handles the Cloud to Device (C2D) message setAlarm
async function setAlarmCommandHandler(msg) {
    try {
        // delete the message from the device queue
        await client.complete(msg);
    }
    catch (err) {
        console.log(`Error handling C2D method: ${err.message}`);
    }
}


// Connect the device and start processing telemetry, properties and commands
(async () => {
    try {
        console.log('Press Ctrl-C to exit from this when running in the console');

        // connect to IoT Central/Hub via Device Provisioning Service (DPS)
        await connect();

        // start the interval timers to send telemetry and reported properties
        let sendTelemetryLoop = null;
        let sendReportedPropertiesLoop = null;

        if (telemetrySendOn) {
            sendTelemetryLoop = setInterval(sendTelemetry, telemetrySendIntervalMs);
        }

        if (reportedPropertySendOn) {
            sendReportedPropertiesLoop = setInterval(sendReportedProperty, propertySendIntervalMs);
        }

        // exit handler for cleanup of resources
        async function exitHandler(options, exitCode) {
            if (options.cleanup) {
                console.log('\nCleaning up and exiting');

                if (sendTelemetryLoop !== null) {
                    clearInterval(sendTelemetryLoop);
                }
                if (sendReportedPropertiesLoop !== null) {
                    clearInterval(sendReportedPropertiesLoop);
                }

                if (wsServer) {
                    console.log('Close WebSocket server');
                    wsServer.close();
                }

                if (relayServer) {
                    console.log('Close Relay server');
                    relayServer.close();
                }

                await client.close();
            }
            if (options.exit) {
                process.exit();
            }
        }

        // try and cleanly exit when ctrl-c is pressed
        process.on('exit', exitHandler.bind(null, { cleanup: true }));
        process.on('SIGINT', exitHandler.bind(null, { exit: true }));
        process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
        process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));

    } catch (e) {
        console.log(`Error: ${e}`);
    }
})();

function startRelayListener(ns, path, keyrule, key) {
    const clients = {};

    // start the device listener service. This service connects to Azure Relay service,
    // passing a callback that when a client connects, creates an SSH client that talks 
    // to the device's SSH server. When data requests come from connections to the device 
    // listener server, they are passed to the SSH client. Responses from the SSH client 
    // are converted to binary format and passed back to the connection.

    if (relayServer && (relayServer.readyState !== WebSocket.CLOSING || relayServer.readyState !== WebSocket.CLOSED)) {
        console.log('Relay server already connecting or connected');
        return relayServer;
    }

    function getUniqueID() {
        function s4() {
            return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
        }
        return s4() + s4() + '-' + s4();
    };

    const server = WebSocket.createRelayListenUri(ns, path);
    const token = function() { return WebSocket.createRelayToken('http://' + ns, keyrule, key); };
    // wss is the websocket server on the device that listens for connections from relay clients (from IoT Central)
    const wss = WebSocket.createRelayedServer(
        {
            server,
            token
        }, 
        (ws) => {  // ws is an individual client websocket connection (terminal session from IoT Central client)
            try {

                console.log('relayed connection accepted');

                const username = new URL(ws.url).searchParams.get('username');

                ws.id = getUniqueID();
                clients[ws.id] = ws;

                wss.clients.forEach(function each(client) {
                    console.log('Client.ID: ' + client.id);
                });

                ws.on('open', async () => {
                    ws.send(`Type your password and hit enter: `);
                });

                // start SSH client and connect to local SSH
                const sshConn = new SSHClient();

                sshConn.on('ready', () => {
                    console.log('---- SSH SESSION READY ----');

                    sshConn.shell((err, stream) => {
                        if (err) throw err;

                        stream.on('close', () => {
                            console.log('closing SSH client');
                            sshConn.end();
                            if (clients[ws.id]) {
                                clients[ws.id].close();
                            }
                        }).on('data', (data) => {  // from SSH output stream
                            ws.send(data.toString('binary'));
                        });

                        ws.on('message', function message(data) { // terminal input from IoT Central
                            stream.write(data);
                        });

                    });
                }).on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
                    console.log('---- KEYBOARD-INTERACTIVE ----')
                    let password = '';
                    ws.on('message', (data) => {
                        if (NEWLINE.includes(data)) {
                            ws.send('\r\n');
                            ws.onmessage = null;
                            try {
                                finish([password]);
                            } catch (pwdError) {
                                console.log(pwdError);
                                password = '';
                            }
                            
                        } else {
                            if (data.charCodeAt(0) === 127) { // backspace from UX is sent as Delete
                                if (password.length) {
                                    password = password.substring(0, password.length - 1);
                                    ws.send('\b');  // back up the cursor in the terminal UX
                                } else {
                                    password = '';
                                }
                            } else {
                                password = password.concat(data);
                                ws.send('*');
                            }
                            const hiddenPassword = password.replace(/(.)/g, '*');
                            console.log('Password:', hiddenPassword);                       
                        }
                    });
                }).connect({
                    host,
                    port,
                    username,
                    tryKeyboard: true,
                    readyTimeout: 30 * 1000,
                    debug: console.log,
                }).on('error', (error) => {
                    const errorMessage = `Error occurred connecting to SSH server: ${error.message}`;
                    console.log(errorMessage);
                    ws.close(1011, errorMessage);
                });

                ws.on('close', function close() {
                    console.log(`Client ${ws.id} connection closed.`);
                    clients[ws.id] = undefined;
                    if (!Object.keys(clients).length) {
                        console.log('No other clients are connected.');
                        wss.close();
                    }
                });

            } catch (error) {
                console.log(`Error occurred: ${error.message}`);
                ws.close();
            }
        }
    );

    wss.on('error', (err) => {
        console.log('---------- ERROR ----------')
        console.log(`Error: ${err.message}`, err);
        if (relayServer !== wss) {
            throw err;
        }
        console.log('Clearing relayServer listener.')
        listenerConnectionString = undefined;
        wss.clients.forEach(client => client.close());
        if (relayServer) {
            relayServer.close(); 
        }
        relayServer = undefined;
    });

    wss.on('close', function close() {
        console.log('shutting down relayed server');
        if (relayServer) {
            relayServer.close(); // null check in case of race between stop command and wss.close() in ws onClose handler
        }
        relayServer = undefined;
    });

    console.log(`Relayed Server started @ ${Date.now()}`);
    return wss;
}

function getLocalIpAddress() {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const results = Object.create(null);
    for (const name of Object.keys(nets)) {
        if (name[0] == 'v' || name[0] == 'V')  // looking for virtual network adapter names and ignoring them
            continue;
        for (const net of nets[name]) {
            const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4
            if (net.family === familyV4Value && !net.internal) {
                results[name] = net.address;
            }
        }
    }
    const values = Object.values(results);
    const ipAddress = results['eth0'] || values[0];
    return ipAddress;
}
