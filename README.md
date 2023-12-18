# vmix-ts

A (mostly) typesafe wrapper for the [vMix TCP API](https://www.vmix.com/help24/ShortcutFunctionReference.html), tested with vMix 26+.

## Installation

```sh
npm install vmix-ts
# or
yarn add vmix-ts
```

## Usage

```ts
import { VMixConnection } from "vmix-ts";

const conn = await VMixConnection.connect({ host: "localhost", port: 8099 });
await conn.addInput("Video", "C:\\video.mp4");
```

### `stateSchemaMismatchMode`

`vmix-ts` has internal validation for the data returned by the vMix API, however it's possible that it changes between vMix versions before we can update it.
To control its behaviour, use the `stateSchemaMismatchMode` parameter:

```ts
import { VMixConnection } from "vmix-ts";

const conn = await VMixConnection.connect({
  host: "localhost",
  port: 8099,
  stateSchemaMismatchMode: "log", // or "error" or "ignore"
});
```

In "log" mode, a warning will be logged to the console when a mismatch is detected.
In "error" mode, an error will be thrown.

If you see these errors, please open an issue!
