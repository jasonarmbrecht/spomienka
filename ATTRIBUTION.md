# Third-Party Software Attribution

This project uses the following open source software:

## Frontend/Admin Dependencies

### Core Libraries
- **React** (MIT License) - Copyright (c) Meta Platforms, Inc.
  - https://github.com/facebook/react
- **PocketBase JS SDK** (MIT License) - Copyright (c) Gani Georgiev
  - https://github.com/pocketbase/js-sdk
- **React Router** (MIT License) - Copyright (c) Remix Software Inc.
  - https://github.com/remix-run/react-router

### Build Tools
- **Vite** (MIT License) - Copyright (c) 2019-present, Yuxi (Evan) You
  - https://github.com/vitejs/vite
- **TypeScript** (Apache License 2.0) - Copyright (c) Microsoft Corporation
  - https://github.com/microsoft/TypeScript

## Backend Dependencies

### Database & API
- **PocketBase** (MIT License) - Copyright (c) Gani Georgiev
  - https://github.com/pocketbase/pocketbase

### External Tools (Required at Runtime)
- **FFmpeg** (LGPL 2.1+ or GPL 2+, depending on build configuration)
  - https://ffmpeg.org/
  - Used for media transcoding and processing
- **ExifTool** (Artistic License or GPL)
  - https://exiftool.org/
  - Used for metadata extraction

## Viewer (Rust) Dependencies

- **anyhow** (MIT or Apache-2.0) - Copyright (c) David Tolnay
  - https://github.com/dtolnay/anyhow
- **serde** (MIT or Apache-2.0) - Copyright (c) Erick Tryzelaar and David Tolnay
  - https://github.com/serde-rs/serde
- **serde_json** (MIT or Apache-2.0) - Copyright (c) Erick Tryzelaar and David Tolnay
  - https://github.com/serde-rs/json
- **reqwest** (MIT or Apache-2.0) - Copyright (c) Sean McArthur
  - https://github.com/seanmonstar/reqwest
- **tokio** (MIT License) - Copyright (c) Tokio Contributors
  - https://github.com/tokio-rs/tokio
- **config** (MIT or Apache-2.0) - Copyright (c) Ryan Leckey
  - https://github.com/mehcode/config-rs

## License Compatibility

All dependencies used in this project are compatible with the MIT License under which Spomienka is released. Users and distributors should be aware of the following:

1. **FFmpeg and ExifTool**: These tools are runtime dependencies installed on the system. If you distribute binaries that include FFmpeg built with GPL components, you must comply with GPL terms for those components.

2. **JavaScript/TypeScript dependencies**: All are MIT licensed and fully compatible.

3. **Rust dependencies**: All are dual-licensed MIT/Apache-2.0, allowing use under MIT.

## Acknowledgments

We are grateful to all the open source maintainers and contributors whose work makes this project possible.

