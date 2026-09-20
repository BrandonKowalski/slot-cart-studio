# Slot Cart Studio

A browser app for creating cartridge labels for a slot SD card. Rust builds the
WebAssembly renderer; the frontend is static HTML, CSS, and JavaScript.

## Run locally

Requirements: Git, Rust (via rustup), wasm-pack 0.15.0, and Python 3. The repository's
`rust-toolchain.toml` selects Rust 1.96 and the WebAssembly target automatically.

The studio compiles source and assets from a **sibling** `slot` checkout. From the
directory containing this repository:

```sh
git clone https://github.com/BrandonKowalski/slot.git slot
git -C slot checkout --detach "$(cat slot-cart-studio/slot.ref)"
cd slot-cart-studio
wasm-pack build --release --target web --no-typescript --out-dir web/pkg -- --locked
python3 -m http.server 8765 --bind 127.0.0.1 --directory web
```

Open http://127.0.0.1:8765/ and choose your SD card's root directory (the directory
containing `Games`). Chrome supports writing labels back to the card; browsers
without directory-write support download a ZIP instead. Stop the server with
Ctrl+C. After building once, only the final Python command is needed to restart.

Game databases and artwork are fetched online. An optional custom art set can be
provided through the existing `?art=` URL parameter. The app needs no backend or
account for its default libretro workflow.

## Build repair

The failed Pages build at studio commit `034e531` called `cart::cart_box`, but
`slot.ref` selected `893b953`, which did not define it. The calls were introduced
in the earlier studio commit `0312719`.

The corrected pin is `696574424ea9a866c89a551292b34f397ba2d613`, the slot revision
that introduces Game Boy cartridge geometry. Its `cart_box` takes a `ShelfKind`,
so both callers convert their `Platform` with `.shelf()`. The pin-check task also
tracks the new Game Boy assets and platform dependencies.

## Checks

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --lib --target wasm32-unknown-unknown -- -D warnings
cargo test --locked
```

The face tests compare studio rendering with slot's rendering and verify that
GBA, GB, and GBC canvas and scan dimensions agree. `tools/verify.py` additionally
requires the author's untracked `slot/sdcard` ROM fixtures; it is not a standalone
test for a fresh clone.
