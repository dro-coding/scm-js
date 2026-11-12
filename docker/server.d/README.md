# docker/server.d

Extra nginx directives for one deployment of the image, read inside the editor's `server`
block by `include /etc/nginx/server.d/*.conf;` in `docker/nginx.conf`. The folder holds no
`.conf` here, so the image as built from this repository serves plain HTTP on port 80
exactly as before; only this README is copied in, and the pattern does not match it.

There are two ways to add a file:

- **When the container starts:** mount it over the folder, for example
  `-v ./tls.conf:/etc/nginx/server.d/tls.conf:ro`.
- **When the image is built:** put it in this folder of the build context before
  `docker build`. The image then needs whatever the file names, such as a certificate,
  every time it starts.

HTTPS is the usual reason. Because the file is included in the same `server`, it adds a port
to the existing locations and does not repeat them:

```nginx
listen 443 ssl;
listen [::]:443 ssl;
http2 on;
ssl_certificate     /certs/fullchain.pem;
ssl_certificate_key /certs/privkey.pem;

# Send plain HTTP to HTTPS.
if ($server_port = 80) {
    return 302 https://scm.example.org$request_uri;
}
```

Over HTTPS the browser lets the editor keep the game graphics in its own storage (OPFS) and,
in Chrome and Edge, save a map back to the file it was opened from.
