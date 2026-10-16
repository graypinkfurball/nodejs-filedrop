// Copyright 2026 Pink
// MIT License

const process = require('node:process');
const path = require('node:path');
const fs = require('node:fs');

// HTTPS_CERT=certdir[:certfile:keyfile]
// HTTP(S)_PORT=port
// FILEDROP_DIR=dir

let server, port;
if (process.env['HTTPS_CERT']) {
  const https = require('node:https');
  const [certdir, certfile, keyfile] = process.env['HTTPS_CERT'].split(':', 3);
  server = https.createServer({
    cert: fs.readFileSync(path.join(certdir, certfile || 'cert.pem')),
    key: fs.readFileSync(path.join(certdir, keyfile || 'key.pem')),
  });
  port = parseInt(process.env['HTTPS_PORT']) || 44301;
} else {
  const http = require('node:http');
  server = http.createServer();
  port = parseInt(process.env['HTTP_PORT']) || 8080;
}

function debug_output(data) {
  data = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
  // \n and \r\n sequences are made visible for debugging purposes
  // any non-printable characters minus the main whitespace control characters
  //   are converted to question marks to avoid terminal shenangins
  data = data.toString('latin1')
    .replaceAll('\n','\\n\n').replaceAll('\r\\n\n','\\r\\n\r\n')
    .replace(/[^\r\n\t\v\f -~]/g,'?');
  console.log(data);
  console.log('########################');
}

// https://www.w3.org/Protocols/rfc1341/7_2_Multipart.html

const dash_double = Buffer.from('--');
const crlf = Buffer.from('\r\n');
const crlf_double = Buffer.from('\r\n\r\n');

function buf_split_at(buf, sepbuf) {
  const i = buf.indexOf(sepbuf);
  return i > -1 ? [buf.subarray(0, i), buf.subarray(i+sepbuf.length)] : [buf];
}

function split_at(s, sep) {
  const i = s.indexOf(sep);
  return i > -1 ? [s.substring(0, i), s.substring(i+sep.length)] : [s];
}

function parse_keyvalues(s, entsep, kvsep) {
  let map;
  for (const ent of s.split(entsep)) {
    const [key, value] = split_at(ent, kvsep);
    if (value) {
      if (!map) { map = new Map(); }
      map.set(key.trim().toLowerCase(), value.trim());
    }
  }
  return map;
}

function parse_header(s) {
  const [value, rawparams] = split_at(s, ';');
  let params;
  if (rawparams) {
    params = parse_keyvalues(rawparams, ';', '=');
    for (const [key, value] of params) {
      // lazy parsing of quoted strings
      if (value[0] == '"') { params.set(key, value.substring(1, value.length-1)); }
    }
  }
  return [value.trim().toLowerCase(), params];
}

function parse_headers(data) {
  // no headers present
  if (data.subarray(0,2).equals(crlf)) {
    data = data.subarray(2);
    return [data];
  }

  let rawheaders, headers;
  [rawheaders, data] = buf_split_at(data, crlf_double);
  if (data) { headers = parse_keyvalues(rawheaders.toString('latin1'), '\r\n', ':'); }
  return [data, headers];
}

// boundaries are assumed to be continous within each block of data
function handle_multipart_delim(data, delim) {
  let last = false;
  let chunk;
  [chunk, data] = buf_split_at(data, delim);
  if (data) {
    const after = data.subarray(0,2);
    data = data.subarray(2);
    if (after.equals(dash_double)) { last = true; }
    else if (!after.equals(crlf)) { chunk = null; /* error */ }
  }
  return [last, chunk, data];
}

function handle_multipart(req, validate_subtype, on_part, on_end, on_error) {
  if (!req.headers['content-type']) { return on_error(new Error("missing content type")); }
  let delim; {
    const [mediatype, params] = parse_header(req.headers['content-type']);
    const [type, subtype] = split_at(mediatype, '/');
    if (type != 'multipart' || !subtype || !validate_subtype(subtype)
      || !params.has('boundary')) { return on_error(new Error("invalid content type for multipart")); }
    delim = Buffer.from('\r\n--'+params.get('boundary'));
  }

  let ended = false;
  function end() {
    ended = true;
    req.off('data', handle_data);
  }

  let chunks = [];
  function handle_data(data) {
    if (ended) { return; }
    while (data.length > 0) {
      let last, chunk;
      [last, chunk, data] = handle_multipart_delim(data, delim);
      if (!chunk) { end(); return on_error(new Error("malformed boundary")); }

      chunks.push(chunk);
      if (!data) { return; }

      let part = Buffer.concat(chunks);
      chunks.length = 0;

      let headers;
      [part, headers] = parse_headers(part);
      if (!part) { end(); return on_error(new Error("malformed headers")); }

      try {
        on_part(part, headers, end);
      } catch (e) { end(); return on_error(e); }
      if (ended) { return; }

      // skip parsing unused epilogue
      if (last) { end(); return on_end(); }
    }
  }

  // skip parsing unused preamble
  const preamble_delim = delim.subarray(2);
  req.on('data', function handle_preamble(data) {
    let last, chunk;
    [last, chunk, data] = handle_multipart_delim(data, preamble_delim);
    if (!chunk || last) {
      req.off('data', handle_preamble);
      return on_error(new Error("malformed boundary"));
    } else if (data) {
      req.off('data', handle_preamble);
      req.on('data', handle_data);
      handle_data(data);
    }
  });
}

function handle_form_data(req, on_form_data, on_end, on_error) {
  handle_multipart(req, subtype => subtype == 'form-data', (data, headers, end) => {
    if (!headers || !headers.has('content-disposition')) { end(); return on_error(new Error("missing content disposition")); }
    const [disptype, params] = parse_header(headers.get('content-disposition'));
    if (disptype != 'form-data' || !params.has('name')) { end(); return on_error(new Error("malformed content disposition")); }
    const name = params.get('name');
    params.delete('name');
    on_form_data(name, data, params, headers);
  }, on_end, on_error);
}

function timestamp() {
  function f(n) { return n.toString().padStart(2,'0'); }
  const d = new Date();
  let s = d.getFullYear() + f(d.getMonth()) + f(d.getDate())
    + "_" + f(d.getHours()) + f(d.getMinutes()) + f(d.getSeconds());
}

// fs.existsSync race condition acknowledged but ignored
function next_free_file(filepath, last_index) {
  if (!fs.existsSync(filepath)) { return filepath; }

  const dirname = path.dirname(filepath);
  const extname = path.extname(filepath);
  const basename = path.basename(filepath, extname);
  for (let i = last_index ? last_index[0] : 2; i <= 99; i++) {
    const new_filename = basename + '_' + i + extname;
    const new_filepath = path.join(dirname, new_filename);
    if (!fs.existsSync(new_filepath)) {
      if (last_index) { last_index[0] = i; }
      return new_filepath;
    }
  }

  throw new Error('no free file');
}

function chroot_file(filepath, rootpath) {
  filepath = path.join(rootpath, path.normalize(path.join(path.sep, filepath)));
  if (!filepath.startsWith(rootpath)) { throw new Error('bad file path'); }
  return filepath;
}

const page = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>File Drop</title>
<style>
* {
  font-family: sans-serif;
  font-size: 24px;
}
#file {
  width: 600px;
  height: 200px;
  padding: 4px;
  border: 1px solid black;
  margin-bottom: 4px;
}
</style>
</head>
<body>
<form action="/" method="post" enctype="multipart/form-data">
<input type="file" id="file" name="file" multiple>
<br/>
<input type="submit" value="Upload">
</form>
</body>
</html>
`;

const files_dir = path.resolve(__dirname, process.env['FILEDROP_DIR'] || 'files');
fs.mkdirSync(files_dir, { recursive: true });

server.on('request', (req, res) => {
  function bad_request(res) { res.writeHead(400).end(); }
  function send_page() {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(page, 'utf-8') })
      .end(page, 'utf-8');
  }

  if (req.method == 'GET') { send_page(); }
  else if (req.method == 'POST') {
    const default_filename = "upload_" + timestamp();
    let default_last_index = [ 2 ];

    let files = 0;
    handle_form_data(req, (name, data, params) => {
      let filepath;
      if (params.has('filename')) {
        filepath = next_free_file(chroot_file(params.get('filename'), files_dir));
      } else {
        filepath = next_free_file(chroot_file(default_filename, files_dir), default_last_index);
      }

      if (fs.dirname(filepath) != files_dir) { throw new Error("subdirectory creation disallowed"); }

      fs.writeFileSync(filepath, data);
      console.log(filepath);
      files += 1;
    }, () => {
      send_page(res);
      console.log("Uploaded " + files + (files == 1 ? " file." : " files."));
    }, e => {
      console.error(e);
      try { bad_request(res); } catch(e) {}
    });
  } else { bad_request(); }
}).listen(port);

console.log("Listening on port " + port);
