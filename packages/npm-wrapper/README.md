# thevoid

Terminal-native ephemeral social platform. Ham radio for the internet.

## Install

```
npm i -g thevoid
```

Then run:

```
void
```

## What this package is

A thin wrapper that, at `npm install` time, downloads the right pre-compiled
void binary for your platform from the official release manifest, verifies
its SHA256, and exposes it as the `void` command.

The binary is signed and notarized for macOS, and the post-install script
verifies its integrity before exposing it.

## Updating

void self-updates silently on every launch. You should not need to
`npm update` manually, but doing so will also work — npm install will
re-fetch whatever the manifest currently points at.

## Source

See [github.com/DotComputers/voidtui](https://github.com/DotComputers/voidtui).
