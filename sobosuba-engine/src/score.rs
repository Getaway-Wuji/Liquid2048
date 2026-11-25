/// Little-endian 32-bit limbs, with no score cap at the JavaScript safe integer.
#[derive(Default)]
pub struct Score {
    words: Vec<u32>,
}

impl Score {
    pub fn add_power_of_two(&mut self, level: u32) {
        let mut index = (level / 32) as usize;
        if index >= self.words.len() {
            self.words.resize(index + 1, 0);
        }
        let mut addend = 1 << (level % 32);
        loop {
            let (word, carry) = self.words[index].overflowing_add(addend);
            self.words[index] = word;
            if !carry {
                break;
            }
            index += 1;
            if index == self.words.len() {
                self.words.push(0);
            }
            addend = 1;
        }
    }

    pub fn decimal(&self) -> String {
        if self.words.is_empty() {
            return "0".to_owned();
        }
        let mut words = self.words.clone();
        let mut chunks = Vec::new();
        // Repeated base-10⁹ division visits each 32-bit limb using a 64-bit remainder.
        while !words.is_empty() {
            let mut rem = 0_u64;
            for word in words.iter_mut().rev() {
                let current = (rem << 32) | u64::from(*word);
                *word = (current / 1_000_000_000) as u32;
                rem = current % 1_000_000_000;
            }
            chunks.push(rem);
            while words.last() == Some(&0) {
                words.pop();
            }
        }
        let mut text = chunks.pop().expect("nonzero score").to_string();
        use std::fmt::Write;
        for chunk in chunks.into_iter().rev() {
            write!(&mut text, "{chunk:09}").expect("writing into a string");
        }
        text
    }
}
