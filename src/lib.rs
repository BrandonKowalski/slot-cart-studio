//! slot cart studio. Four of slot's own source files are compiled here unchanged, so a preview
//! is the device's cart face rather than an imitation of it. They reach each other through
//! `crate::` paths, which is why they sit at the root. `art` is the one module swapped out:
//! slot's reads a label from disk, and a browser has no disk.

#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../slot/crates/slot-ui/src/cart.rs"]
mod cart;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../slot/crates/slot-ui/src/shell.rs"]
mod shell;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../slot/crates/slot-ui/src/silhouette.rs"]
mod silhouette;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../slot/crates/slot-ui/src/text.rs"]
mod text;

mod art;
pub mod dat;
pub mod face;
pub mod hue;
pub mod label;
pub mod libretro;
pub mod rom;
pub mod zip;

use wasm_bindgen::prelude::*;

/// The cart face's size, `[w, h]`, so the page sizes its canvases from slot.
#[wasm_bindgen]
pub fn cart_size() -> Vec<u32> {
    vec![cart::CART_W, cart::CART_H]
}

/// A label the card already has, on its cart.
#[wasm_bindgen]
pub fn existing_face(png: &[u8], code: &str, stem: &str) -> Vec<u8> {
    face::from_png(png, code, stem)
}

/// A ROM's CRC32, fed in the chunks the page reads it in.
#[wasm_bindgen(js_name = Crc32)]
#[derive(Default)]
pub struct JsCrc32(rom::Crc32);

#[wasm_bindgen(js_class = Crc32)]
impl JsCrc32 {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, chunk: &[u8]) {
        self.0.update(chunk);
    }

    pub fn finish(self) -> u32 {
        self.0.finish()
    }
}

#[wasm_bindgen(js_name = Dat)]
pub struct JsDat(dat::Dat);

#[wasm_bindgen(js_class = Dat)]
impl JsDat {
    pub fn parse(text: &str) -> JsDat {
        JsDat(dat::Dat::parse(text))
    }

    pub fn game_for(&self, crc: u32) -> Option<String> {
        self.0.game_for(crc).map(str::to_string)
    }

    /// How many dumps the database names, for the page to mention.
    pub fn games(&self) -> usize {
        self.0.len()
    }
}

#[wasm_bindgen]
pub fn header_code(head: &[u8]) -> String {
    rom::header_code(head)
}

#[wasm_bindgen]
pub fn thumbnail_name(game: &str) -> String {
    libretro::thumbnail_name(game)
}

#[wasm_bindgen]
pub fn stub_target(body: &[u8]) -> Option<String> {
    libretro::stub_target(body)
}

#[wasm_bindgen]
pub fn box_hue(png: &[u8]) -> Option<u16> {
    hue::box_hue(png)
}

#[wasm_bindgen]
pub fn fallback_hue(stem: &str) -> u16 {
    hue::fallback_hue(stem)
}

/// The title slot puts on a cart with no label art: the stem without its bracketed tags or its
/// spaced-hyphen subtitle break. The page names a cart the way the device does.
#[wasm_bindgen]
pub fn clean_label(stem: &str) -> String {
    cart::clean_label(stem)
}

/// The bracketed groups `clean_label` drops, in order, one per group: `USA, Europe`, `Rev 1`.
#[wasm_bindgen]
pub fn label_tags(stem: &str) -> Vec<String> {
    cart::label_tags(stem)
}

/// A label for one cart: a logo that recomposes as its hue moves.
#[wasm_bindgen(js_name = Label)]
pub struct JsLabel(label::Label);

#[wasm_bindgen(js_class = Label)]
impl JsLabel {
    #[wasm_bindgen(constructor)]
    pub fn new(logo_png: &[u8], hue: u16) -> Result<JsLabel, JsError> {
        label::Label::from_png(logo_png, hue)
            .map(JsLabel)
            .ok_or_else(|| JsError::new("not a PNG this studio can read"))
    }

    pub fn hue(&self) -> u16 {
        self.0.hue()
    }

    pub fn set_hue(&mut self, hue: u16) {
        self.0.set_hue(hue);
    }

    pub fn face(&self, code: &str, stem: &str) -> Vec<u8> {
        self.0.face(code, stem)
    }

    pub fn png(&self) -> Vec<u8> {
        self.0.png()
    }
}

/// Labels for a browser that can't write to the card, to unzip at its root.
#[wasm_bindgen(js_name = Zip)]
#[derive(Default)]
pub struct JsZip(zip::Zip);

#[wasm_bindgen(js_class = Zip)]
impl JsZip {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, name: &str, data: &[u8]) {
        self.0.add(name, data);
    }

    pub fn take(&mut self) -> Vec<u8> {
        self.0.take()
    }

    pub fn finish(self) -> Vec<u8> {
        self.0.finish()
    }
}
