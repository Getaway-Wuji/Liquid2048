const UPPER_TIER_WEIGHTS: [u32; 7] = [64, 32, 16, 8, 4, 2, 1];
const MAX_SUPPLY_LEVEL: u32 = 1 + UPPER_TIER_WEIGHTS.len() as u32;

pub fn generated_level(random: u32, highest_level: u32) -> u32 {
    // The opening offers 2 and 4. Each later tier stays below the best made this
    // round, with the 256 ceiling keeping the supply playable in a crowded arena.
    let ceiling = highest_level.saturating_sub(1).clamp(2, MAX_SUPPLY_LEVEL);
    let upper_weights = &UPPER_TIER_WEIGHTS[..(ceiling - 1) as usize];
    let two_weight = if ceiling == 2 { 576 } else { 400 };
    let total_weight = two_weight + upper_weights.iter().sum::<u32>();
    let mut ticket = ((u64::from(random) * u64::from(total_weight)) >> 32) as u32;

    for (index, &weight) in upper_weights.iter().enumerate().rev() {
        if ticket < weight {
            return index as u32 + 2;
        }
        ticket -= weight;
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn distribution(highest_level: u32, total_weight: u32) -> [u32; 8] {
        let mut counts = [0; 8];
        for ticket in 0..total_weight {
            let random = (((2 * u64::from(ticket) + 1) << 31) / u64::from(total_weight)) as u32;
            counts[(generated_level(random, highest_level) - 1) as usize] += 1;
        }
        counts
    }

    #[test]
    fn opening_generates_two_and_four_at_ninety_ten() {
        for highest_level in 0..=3 {
            assert_eq!(
                distribution(highest_level, 640),
                [576, 64, 0, 0, 0, 0, 0, 0]
            );
        }
    }

    #[test]
    fn later_tiers_unlock_one_level_below_the_round_best() {
        for highest_level in 4..=9 {
            let upper = &UPPER_TIER_WEIGHTS[..(highest_level - 2) as usize];
            let counts = distribution(highest_level, 400 + upper.iter().sum::<u32>());
            assert_eq!(counts[0], 400);
            assert_eq!(&counts[1..highest_level as usize - 1], upper);
            assert!(
                counts[highest_level as usize - 1..]
                    .iter()
                    .all(|&weight| weight == 0)
            );
        }
    }

    #[test]
    fn supply_caps_at_256_and_still_favors_small_values() {
        let total_weight = 400 + UPPER_TIER_WEIGHTS.iter().sum::<u32>();
        let counts = distribution(u32::MAX, total_weight);
        assert_eq!(counts, [400, 64, 32, 16, 8, 4, 2, 1]);
        assert!(counts[0] + counts[1] > total_weight * 4 / 5);
    }
}
