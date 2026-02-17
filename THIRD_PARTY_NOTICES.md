# Third-Party Notices
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Garbanzo depends on third-party open source software.

- JavaScript/TypeScript dependencies are installed via npm and retain their own licenses in `node_modules/`.
- The Docker image includes OS packages from Alpine Linux repositories.

This file is not an exhaustive license inventory. It is intended to call out notable bundled components and where to find their corresponding source and license terms.

## Docker Image (Alpine Packages)

The official Docker image installs packages using `apk` from Alpine Linux repositories.

Notable packages:

- `ffmpeg` (multimedia processing)
- `yt-dlp` (YouTube downloader)
- `dumb-init` (PID 1 init/signal handling)
- `curl` (health probe)

Alpine package sources and build scripts (aports):

- https://git.alpinelinux.org/aports

Upstream project sources:

- FFmpeg: https://ffmpeg.org/
- yt-dlp: https://github.com/yt-dlp/yt-dlp
- dumb-init: https://github.com/Yelp/dumb-init
- curl: https://curl.se/

## Important Note

Some bundled components (for example, FFmpeg builds) may be available under licenses that carry additional obligations when distributing binaries.

If you plan to redistribute Garbanzo commercially, make sure your distribution process includes appropriate notices and satisfies any relevant copyleft requirements of bundled components.
