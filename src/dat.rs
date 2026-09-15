//! The No-Intro GBA DAT as libretro-database publishes it: clrmamepro text, one `game ( ... )`
//! block per dump, with the dump's CRC32 on its `rom ( ... )` line.

use std::collections::HashMap;

pub struct Dat {
    by_crc: HashMap<u32, String>,
}

impl Dat {
    /// Lines outside a game block, such as the `clrmamepro` header, name nothing that has a CRC.
    /// A CRC listed twice keeps its first name.
    pub fn parse(text: &str) -> Self {
        let mut by_crc = HashMap::new();
        let mut name: Option<String> = None;
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with("game (") {
                name = None;
            } else if let Some(rest) = line.strip_prefix("name \"") {
                name = rest.rfind('"').map(|end| rest[..end].to_string());
            } else if line.starts_with("rom (") {
                let crc = line
                    .split_whitespace()
                    .skip_while(|token| *token != "crc")
                    .nth(1)
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok());
                if let (Some(crc), Some(name)) = (crc, &name) {
                    by_crc.entry(crc).or_insert_with(|| name.clone());
                }
            }
        }
        Self { by_crc }
    }

    pub fn game_for(&self, crc: u32) -> Option<&str> {
        self.by_crc.get(&crc).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.by_crc.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_crc.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXCERPT: &str = include_str!("../tests/fixtures/gba-excerpt.dat");

    #[test]
    fn each_crc_finds_its_game() {
        let dat = Dat::parse(EXCERPT);
        assert_eq!(dat.len(), 3);
        assert_eq!(dat.game_for(0x6C75_479C), Some("Metroid Fusion (USA)"));
        assert_eq!(
            dat.game_for(0x1F1C_08FB),
            Some("Pokemon - Emerald Version (USA, Europe)")
        );
        assert_eq!(
            dat.game_for(0x7570_3943),
            Some("2 Disney Games - Lilo & Stitch 2 + Peter Pan - Return to Neverland (Europe) (En,Fr,De,Es+En,Fr,De,Es,It,Nl)")
        );
    }

    #[test]
    fn an_unknown_crc_finds_nothing() {
        assert_eq!(Dat::parse(EXCERPT).game_for(0xDEAD_BEEF), None);
    }

    #[test]
    fn windows_line_endings_parse_the_same() {
        let crlf = EXCERPT.replace('\n', "\r\n");
        assert_eq!(
            Dat::parse(&crlf).game_for(0x6C75_479C),
            Some("Metroid Fusion (USA)")
        );
    }
}
