# remote-terminal

Device code:
1. Update ```deviceConfig.json``` configuration values to work with your IoT Central application:

	- **scopeId** -- found at _Permissions > Device connection groups > **ID scope**_
	- **groupSymmetricKey** -- found at _Permissions > Device connection groups > Enrollment groups: SAS-IoT-Devices > **Primary key**_
   - **modelId** -- the id of the device template, found at _Device templates > [Device template containing Remote Terminal interface] > Edit identity > Interface @id_
   - **deviceId** -- the id for your non-simulated device, if it exists already, or the id you want to give to the new device. <p></p>

2. If the SSH host and port that should be used are not 'localhost' and 22, respectively, update ```sshConfig.json``` with the desired host and port values.
   
3. Install node packages: 

   In repo root directory, run

   `npm i`  

4. Run device code with NodeJS on Linux or WSL:

   `node remoteTerminalDevice.js`

