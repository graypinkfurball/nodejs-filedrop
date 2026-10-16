# File Drop

You can run the script with `node server.js`, minified version is available in the releases tab. (`node server.min.js`)
By default, it'll create a folder called `files` in the same directory, and host a simple HTTP webserver to port 8080.

You can host HTTPS by setting env variable `HTTPS_CERT` to a directory containing files `cert.pem`, `key.pem`.
You can also specify the filenames of the cert and key file after the path using colons, e.g. `/path/to/certs:mycert.pem:mykey.pem`
The default port for HTTPS is 44301.

You can change the port by setting env variable `HTTP_PORT` to your desired port, or `HTTPS_PORT` if `HTTPS_CERT` is supplied.
You can also change the filedrop folder using `FILEDROP_DIR` with a relative or absolute path.

## Example Scripts

### Linux
`start.sh`
```sh
#!/bin/sh
HTTP_PORT=8081 FILEDROP_DIR=files2 node server.min.js
```

### Windows
`start.bat`
```
@echo off
set HTTP_PORT=8081
set FILEDROP_DIR=files2
node server.min.js
```
`start.ps1`
```
$env:HTTP_PORT=8081
$env:FILEDROP_DIR=files2
node server.min.js
```
