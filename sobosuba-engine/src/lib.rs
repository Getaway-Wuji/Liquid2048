mod geometry;
mod physics;
mod score;
mod splash;
mod supply;

#[cfg(test)]
mod tests;

use geometry::{NODE_COUNT, Outline, Point, contact};
use physics::{
    Ball, BallId, FLOOR, FULL_PRESSURE, LEFT, RAIL_TRAVEL, RIGHT, STEP_SECONDS, TOP, launch_speed,
    radius, resolve,
};
use score::Score;
use std::cell::RefCell;
use supply::generated_level;

const RACK_X: f32 = 284.0;
const RACK_Y: f32 = 124.0;
const RACK_SLOTS: usize = 4;
const RACK_RADIUS_MAX: f32 = 64.0;
const RACK_GAP: f32 = 0.9;
const RACK_INGRESS_MARGIN: f32 = 24.0;
const RELIEF_ENTRY_HEIGHTS: [f32; 4] = [175.0, 250.0, 105.0, 52.0];
const POOL_THROW_MIN_SPEED: f32 = 210.0;
const POOL_THROW_SPEED_RANGE: f32 = 320.0;
const POOL_THROW_MAX_SPEED: f32 = 550.0;
const SOLVER_PASSES: usize = 4;
const DANGER_CONFIRM_STEPS: u32 = 240;
const SNAPSHOT_HEADER: usize = 43;
const SNAPSHOT_BALL: usize = 37;
const RACK_LEVEL_OFFSETS: [usize; RACK_SLOTS] = [8, 9, 10, 33];
const RACK_ENTRY_OFFSETS: [usize; RACK_SLOTS] = [18, 20, 22, 34];
const RACK_CENTER_OFFSETS: [usize; RACK_SLOTS] = [24, 27, 30, 36];
const RACK_ID_OFFSET: usize = 39;
const RACK_HULL_STRIDE: usize = 5 + NODE_COUNT * 2;
const MERGE_EVENT_SIZE: usize = 5;
const EVENT_WINDOW: usize = 128;

struct RackMotion {
    home: Point,
    body: Ball,
}

struct Game {
    balls: Vec<Ball>,
    slots: [Option<BallId>; RACK_SLOTS],
    rack_motion: [Option<RackMotion>; RACK_SLOTS],
    rack_right: f32,
    left_departure: Option<u32>,
    vacant_radii: [f32; RACK_SLOTS],
    rack_merge: Option<(usize, u32)>,
    rng: u32,
    splash_rng: u32,
    tick: u32,
    next_id: u32,
    highest_level: u32,
    merges: u32,
    scored_merges: u32,
    shots: u32,
    score: Score,
    score_text: String,
    pressure: [f32; 2],
    launch_entries: [Point; RACK_SLOTS],
    launch_mask: u32,
    danger_ticks: u32,
    ended: bool,
    paused: bool,
    last_merge: [f32; MERGE_EVENT_SIZE],
    merge_events: Vec<[f32; MERGE_EVENT_SIZE]>,
    collision_count: u32,
    collision_cooldown: u32,
    order: Vec<usize>,
    pairs: Vec<(usize, usize)>,
    consumed: Vec<bool>,
    pending_merges: Vec<(usize, usize)>,
    spawned: Vec<Ball>,
    snapshot: Vec<f32>,
    rack_hulls: [f32; RACK_SLOTS * RACK_HULL_STRIDE],
}

impl Game {
    fn new(seed: u32) -> Self {
        let mut game = Self {
            balls: Vec::new(),
            slots: [None; RACK_SLOTS],
            rack_motion: std::array::from_fn(|_| None),
            rack_right: RACK_X,
            left_departure: None,
            vacant_radii: [radius(1); RACK_SLOTS],
            rack_merge: None,
            rng: if seed == 0 { 0xA3BF_294D } else { seed },
            splash_rng: (seed ^ 0x74C6_29AB).max(1),
            tick: 0,
            next_id: 1,
            highest_level: 0,
            merges: 0,
            scored_merges: 0,
            shots: 0,
            score: Score::default(),
            score_text: "0".to_owned(),
            pressure: [0.0; 2],
            launch_entries: [Point::default(); RACK_SLOTS],
            launch_mask: 0,
            danger_ticks: 0,
            ended: false,
            paused: false,
            last_merge: [0.0, 0.0, 0.0, 0.0, -1.0],
            merge_events: Vec::with_capacity(EVENT_WINDOW),
            collision_count: 0,
            collision_cooldown: 0,
            order: Vec::new(),
            pairs: Vec::new(),
            consumed: Vec::new(),
            pending_merges: Vec::new(),
            spawned: Vec::new(),
            snapshot: Vec::with_capacity(SNAPSHOT_HEADER + SNAPSHOT_BALL * 32),
            rack_hulls: [0.0; RACK_SLOTS * RACK_HULL_STRIDE],
        };
        for slot in 0..RACK_SLOTS {
            let (rng, level) = game.next_supply();
            game.rng = rng;
            game.slots[slot] = Some(game.identity(level));
        }
        let [_, middle, right, far_right] = game.rack_radii();
        game.rack_right = RACK_X + middle + 2.0 * right + far_right + 2.0 * RACK_GAP;
        game.launch_mask = game.unblocked_entries();
        game.write_snapshot();
        game
    }

    fn identity(&mut self, level: u32) -> BallId {
        self.highest_level = self.highest_level.max(level);
        self.body_id(level)
    }

    fn body_id(&mut self, level: u32) -> BallId {
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).expect("entity IDs exhausted");
        BallId::new(id, level)
    }

    fn next_supply(&self) -> (u32, u32) {
        let mut rng = self.rng;
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        (rng, generated_level(rng, self.highest_level))
    }

    fn refill(&mut self) {
        let Some(vacancy) = self.slots.iter().position(Option::is_none) else {
            return;
        };
        if vacancy > 0 {
            // Quickly successive shots can leave more than one empty slot. Let
            // the new drop reach its first mount before feeding it farther right.
            if self
                .held_motion(0)
                .is_some_and(|motion| (motion.home.x - self.rack_centers()[0].x).abs() > 0.5)
            {
                return;
            }
            self.shift_rack(vacancy);
        }

        let (rng, level) = self.next_supply();
        let radius = Self::held_radius(level);
        let mut radii = self.rack_radii();
        radii[0] = radius;
        let centers = self.packed_centers(radii);
        let home = centers[0];
        let leftmost_hold = self
            .slots
            .iter()
            .enumerate()
            .skip(1)
            .filter_map(|(slot, held)| {
                held.map(|held| self.rack_outline(slot, held.level).bounds.min.x)
            })
            .fold(f32::INFINITY, f32::min);
        let entry_x = (home.x - radius * 1.25 - 18.0)
            .min(leftmost_hold - radius - RACK_GAP)
            .max(LEFT + radius + 4.0);
        if entry_x + radius + RACK_GAP > leftmost_hold || entry_x >= home.x {
            return;
        }

        let clearance = Outline::new(home, radius + 3.0, Point::default()).bounds;
        if self.balls.iter().any(|ball| {
            let bounds = ball.outline.bounds;
            let departing = self.left_departure == Some(ball.identity.id)
                && bounds.min.y < clearance.max.y
                && (ball.position.x - home.x).abs() < 54.0;
            let in_path = bounds.min.x <= clearance.max.x
                && bounds.max.x >= entry_x - radius - 3.0
                && bounds.min.y <= clearance.max.y
                && bounds.max.y >= clearance.min.y;
            departing || in_path
        }) {
            return;
        }

        self.left_departure = None;
        self.rng = rng;
        self.rack_right = centers[RACK_SLOTS - 1].x;
        let held = self.identity(level);
        self.slots[0] = Some(held);
        self.rack_motion[0] = Some(Self::mount_drop(held, Point::new(entry_x, RACK_Y)));
    }

    fn mount_drop(held: BallId, home: Point) -> RackMotion {
        let mut body = Ball::new(held, home, Point::default());
        body.set_area(Self::held_radius(held.level).powi(2));
        RackMotion { home, body }
    }

    fn shift_rack(&mut self, vacancy: usize) {
        let origins = self.rack_centers();
        // A drop without motion yet is already visible at its current mount.
        // Capture that location before the new arrangement changes the centers.
        for (index, origin) in origins.into_iter().enumerate() {
            if let Some(held) = self.slots[index]
                && self.held_motion(index).is_none()
            {
                self.rack_motion[index] = Some(Self::mount_drop(held, origin));
            }
        }
        for next in (1..=vacancy).rev() {
            let previous = next - 1;
            self.slots[next] = self.slots[previous].take();
            self.vacant_radii[next] = self.vacant_radii[previous];
            self.rack_motion[next] = self.rack_motion[previous].take();
        }
    }

    fn walls(&self) -> (f32, f32) {
        (
            LEFT - self.pressure[0] * RAIL_TRAVEL,
            RIGHT + self.pressure[1] * RAIL_TRAVEL,
        )
    }

    fn held_radius(level: u32) -> f32 {
        radius(level).min(RACK_RADIUS_MAX)
    }

    fn rack_radii(&self) -> [f32; RACK_SLOTS] {
        std::array::from_fn(|slot| {
            self.slots[slot].map_or(self.vacant_radii[slot], |held| {
                Self::held_radius(held.level)
            })
        })
    }

    fn packed_centers(&self, radii: [f32; RACK_SLOTS]) -> [Point; RACK_SLOTS] {
        let last = RACK_SLOTS - 1;
        let width = radii.iter().sum::<f32>() * 2.0 + last as f32 * RACK_GAP;
        let minimum_right = LEFT + 4.0 + RACK_INGRESS_MARGIN + width - radii[last];
        let right = self.rack_right.max(minimum_right);
        let mut centers = [Point::new(right, RACK_Y); RACK_SLOTS];
        // A refill to the left keeps every downstream target in place.
        for slot in (0..last).rev() {
            centers[slot].x = centers[slot + 1].x - radii[slot] - radii[slot + 1] - RACK_GAP;
        }
        centers
    }

    fn rack_centers(&self) -> [Point; RACK_SLOTS] {
        self.packed_centers(self.rack_radii())
    }

    fn held_motion(&self, slot: usize) -> Option<&RackMotion> {
        self.rack_motion[slot]
            .as_ref()
            .filter(|motion| self.slots[slot] == Some(motion.body.identity))
    }

    fn rack_position(&self, slot: usize, home: Point) -> Point {
        self.held_motion(slot)
            .map_or(home, |motion| motion.body.position)
    }

    fn advance_rack(&mut self) {
        let centers = self.rack_centers();
        self.rack_right = centers[RACK_SLOTS - 1].x;
        for (slot, home) in centers.into_iter().enumerate().rev() {
            let Some(held) = self.slots[slot] else {
                self.rack_motion[slot] = None;
                continue;
            };
            if let Some(motion) = self.held_motion(slot) {
                let travel = home - motion.home;
                let distance = travel.length();
                let delta = if distance < 0.25 {
                    travel
                } else {
                    travel * 0.14
                };
                let can_slide = distance > 0.0 && self.clears_rack_slide(motion, delta);
                let motion = self.rack_motion[slot].as_mut().expect("existing mount");
                if can_slide {
                    motion.body.move_by(delta);
                    motion.home += delta;
                }
                motion.body.advance_mount(motion.home);
            } else {
                self.rack_motion[slot] = Some(Self::mount_drop(held, home));
            }
        }
    }

    fn clears_rack_slide(&self, motion: &RackMotion, delta: Point) -> bool {
        let mut next = motion.body.outline.clone();
        next.translate(delta);
        let increases_overlap = |obstacle: &Outline| {
            contact(&next, obstacle).is_some_and(|touch| {
                touch.depth > 0.38
                    && contact(&motion.body.outline, obstacle)
                        .is_none_or(|old| touch.depth > old.depth + 0.02)
            })
        };
        self.balls
            .iter()
            .all(|ball| !increases_overlap(&ball.outline))
            && (0..RACK_SLOTS).all(|slot| {
                self.held_motion(slot).is_none_or(|other| {
                    other.body.identity == motion.body.identity
                        || !increases_overlap(&other.body.outline)
                })
            })
    }

    fn primary_entry(&self, slot: usize) -> Point {
        let centers = self.rack_centers();
        let mut entry = self.rack_position(slot, centers[slot]);
        let radius = self.slots[slot].map_or(0.0, |ball| radius(ball.level));
        if radius <= RACK_RADIUS_MAX {
            return entry;
        }
        // The launch can start at the surface of the mount if the genuine narrowed
        // outline fits above it. Only exceptionally large drops need a lower mouth.
        let shape = self.launch_footprint(slot, entry);
        if shape.bounds.min.y >= TOP
            && shape.bounds.max.y <= FLOOR
            && self.clears_other_holds(&shape, slot)
        {
            return entry;
        }
        for (other, held) in self.slots.iter().enumerate() {
            if slot == other {
                continue;
            }
            if let Some(held) = held {
                let gap_x = (entry.x - centers[other].x).abs();
                let clearance = radius + Self::held_radius(held.level) + 0.5;
                let gap_y = (clearance * clearance - gap_x * gap_x).max(0.0).sqrt();
                entry.y = entry.y.max(RACK_Y + gap_y);
            }
        }
        // The displayed inlet is independent of the aim. Released drops can be larger
        // than their held silhouette, so they start below the adjacent holds if needed.
        entry.x = entry.x.clamp(LEFT + radius + 8.0, RIGHT - radius - 8.0);
        entry.y = entry.y.clamp(TOP + radius + 8.0, FLOOR - radius - 8.0);
        entry
    }

    fn rack_outline(&self, slot: usize, level: u32) -> Outline {
        let home = self.rack_centers()[slot];
        if let Some(motion) = self.held_motion(slot) {
            return motion.body.outline.clone();
        }
        Outline::new(home, Self::held_radius(level), Point::default())
    }

    fn mount_width(&self, slot: usize, entry: Point) -> Option<f32> {
        let identity = self.slots[slot]?;
        (entry.y == self.rack_position(slot, self.rack_centers()[slot]).y
            && radius(identity.level) > RACK_RADIUS_MAX)
            .then_some(Self::held_radius(identity.level))
    }

    fn launch_footprint(&self, slot: usize, entry: Point) -> Outline {
        let identity = self.slots[slot].expect("candidate inlet contains a drop");
        if let Some(width) = self.mount_width(slot, entry) {
            let mut probe = Ball::new(identity, entry, Point::default());
            probe.narrow_launch(width);
            probe.outline
        } else {
            Outline::new(entry, radius(identity.level), Point::default())
        }
    }

    fn clears_other_holds(&self, outline: &Outline, slot: usize) -> bool {
        self.slots.iter().enumerate().all(|(other, held)| {
            slot == other
                || held.is_none_or(|ball| {
                    contact(outline, &self.rack_outline(other, ball.level)).is_none()
                })
        })
    }

    fn fits_at_entry(&self, outline: &Outline, slot: usize) -> bool {
        let (left, right) = self.walls();
        let bounds = outline.bounds;
        bounds.min.x >= left
            && bounds.max.x <= right
            && bounds.min.y >= TOP
            && bounds.max.y <= FLOOR
            && self
                .balls
                .iter()
                .all(|ball| contact(outline, &ball.outline).is_none())
            && self.clears_other_holds(outline, slot)
    }

    fn unblocked_entries(&mut self) -> u32 {
        self.launch_entries = std::array::from_fn(|slot| self.primary_entry(slot));
        let mut mask = 0;
        for (slot, ball) in self.slots.iter().enumerate() {
            if let Some(ball) = ball {
                let outline = self.launch_footprint(slot, self.launch_entries[slot]);
                if self.fits_at_entry(&outline, slot) {
                    mask |= 1 << slot;
                } else if self.balls.iter().any(|blocker| {
                    blocker.position.y < RACK_Y && contact(&outline, &blocker.outline).is_some()
                }) {
                    // A supported drop may stay above the row indefinitely. Use the
                    // clear pool-facing mouth rather than pushing it through another drop.
                    let release_entry = Point::new(
                        self.launch_entries[slot].x,
                        RACK_Y
                            + self.rack_radii().into_iter().fold(0.0, f32::max)
                            + radius(ball.level)
                            + 8.0,
                    );
                    let release_outline =
                        Outline::new(release_entry, radius(ball.level), Point::default());
                    if self.fits_at_entry(&release_outline, slot) {
                        self.launch_entries[slot] = release_entry;
                        mask |= 1 << slot;
                    }
                }
            }
        }
        if mask != 0 {
            return mask;
        }
        self.open_relief_entries()
    }

    fn open_relief_entries(&mut self) -> u32 {
        // When the regular nozzles are jammed, a rail with travel can feed the
        // adjacent edge. A rail reaching full compression closes its relief inlet.
        let mut mask = 0;
        for (slot, ball) in self.slots.into_iter().enumerate() {
            let Some(ball) = ball else { continue };
            let radius = radius(ball.level);
            let left = LEFT + radius + 14.0;
            let right = RIGHT - radius - 14.0;
            let sides = if slot >= RACK_SLOTS / 2 {
                [(1, right), (0, left)]
            } else {
                [(0, left), (1, right)]
            };
            let candidate = sides
                .into_iter()
                .filter(|&(side, _)| self.pressure[side] < FULL_PRESSURE)
                .flat_map(|(_, x)| {
                    RELIEF_ENTRY_HEIGHTS.map(|y| Point::new(x, y.max(TOP + radius + 8.0)))
                })
                .find(|&point| {
                    self.fits_at_entry(&Outline::new(point, radius, Point::default()), slot)
                });
            if let Some(entry) = candidate {
                self.launch_entries[slot] = entry;
                mask |= 1 << slot;
            }
        }
        mask
    }

    fn legal_launches(&self) -> u32 {
        if self.paused || self.ended {
            return 0;
        }
        self.launch_mask
    }

    fn launch(&mut self, slot: usize, direction: Point, power: f32) -> bool {
        let speed_factor = direction.length();
        if slot >= self.slots.len()
            || self.legal_launches() & (1 << slot) == 0
            || !speed_factor.is_finite()
            || speed_factor < 0.001
            || !(0.0..=1.0).contains(&power)
        {
            return false;
        }
        let entry = self.launch_entries[slot];
        let identity = self.slots[slot].expect("legal entry slot contains a ball");
        let speed = launch_speed(power);
        let velocity = direction * (speed / speed_factor);
        let mut ball = Ball::new(identity, entry, velocity);
        ball.launch_stretch();
        if let Some(width) = self.mount_width(slot, entry) {
            ball.narrow_launch(width);
        }
        if !self.fits_at_entry(&ball.outline, slot) {
            // The initial motion can still deform it on the next physics tick.
            ball = Ball::new(identity, entry, velocity);
            if let Some(width) = self.mount_width(slot, entry) {
                ball.narrow_launch(width);
            }
        }
        ball.set_launch_power(power);
        self.balls.push(ball);
        self.slots[slot] = None;
        self.rack_motion[slot] = None;
        self.vacant_radii[slot] = Self::held_radius(identity.level);
        if slot == 0 {
            self.left_departure = Some(identity.id);
        }
        self.shift_rack(slot);
        self.shots = self.shots.saturating_add(1);
        self.refill();
        self.launch_mask = self.unblocked_entries();
        self.write_snapshot();
        true
    }

    fn throw_drop(&mut self, id: u32, direction: Point, power: f32) -> bool {
        let length = direction.length();
        if self.paused
            || self.ended
            || !length.is_finite()
            || length < 0.001
            || !(0.0..=1.0).contains(&power)
        {
            return false;
        }
        let Some(ball) = self
            .balls
            .iter_mut()
            .find(|body| body.identity.id == id && body.fragment.is_none())
        else {
            return false;
        };

        let speed = POOL_THROW_MIN_SPEED + POOL_THROW_SPEED_RANGE * power;
        let retained_momentum = ball.velocity.limited(380.0) * 0.18;
        ball.velocity =
            (direction * (speed / length) + retained_momentum).limited(POOL_THROW_MAX_SPEED);
        ball.set_launch_power(0.0);
        true
    }

    fn resolve_rack_contacts(&mut self) -> bool {
        let mut collided = false;
        for slot in 0..self.slots.len() {
            let Some(motion) = self.rack_motion[slot].as_mut() else {
                continue;
            };
            let held = motion.body.identity;
            let mut arrived = None;
            for index in 0..self.balls.len() {
                if self.consumed[index] {
                    continue;
                }
                let ball = &self.balls[index];
                let Some(touch) = contact(&ball.outline, &motion.body.outline) else {
                    continue;
                };
                if ball.identity.level == held.level
                    && ball.fragment.is_none()
                    && !self
                        .balls
                        .iter()
                        .zip(&self.consumed)
                        .any(|(piece, consumed)| {
                            !consumed
                                && piece.fragment.is_some_and(|fragment| {
                                    fragment.attached_to(ball.identity, self.tick)
                                })
                        })
                {
                    arrived = Some(ball.identity);
                    self.consumed[index] = true;
                    break;
                }
                collided |= self.balls[index].bump_rack(&mut motion.body, touch);
                motion.body.limit_mount_travel(motion.home);
            }
            if let Some(incoming) = arrived {
                let position = motion.body.position;
                self.slots[slot] = Some(self.merge(incoming, held, position, Some(slot)));
                self.rack_motion[slot] = None;
                self.rack_merge = Some((slot, self.merges));
            }
        }
        for slot in 0..RACK_SLOTS - 1 {
            let [left, right] = self
                .rack_motion
                .get_disjoint_mut([slot, slot + 1])
                .expect("adjacent rack slots");
            if let (Some(left), Some(right)) = (left, right)
                && let Some(touch) = contact(&left.body.outline, &right.body.outline)
            {
                collided |= resolve(&mut left.body, &mut right.body, touch);
                left.body.limit_mount_travel(left.home);
                right.body.limit_mount_travel(right.home);
            }
        }
        collided
    }

    fn merge(&mut self, a: BallId, b: BallId, position: Point, held_slot: Option<usize>) -> BallId {
        debug_assert_eq!(a.level, b.level);
        let mut merged = self.identity(a.level.checked_add(1).expect("ball level exhausted"));
        let earns_a = a.score_ceiling < merged.level;
        let earns_b = b.score_ceiling < merged.level;
        let award_level = match (earns_a, earns_b) {
            (true, true) => Some(merged.level),
            (true, false) | (false, true) => Some(a.level),
            (false, false) => None,
        };
        if let Some(level) = award_level {
            self.score.add_power_of_two(level);
            self.score_text = self.score.decimal();
            self.scored_merges = self.scored_merges.saturating_add(1);
        }
        merged.score_ceiling = merged.level.max(a.score_ceiling).max(b.score_ceiling);
        self.merges = self.merges.saturating_add(1);
        self.last_merge = [
            self.merges as f32,
            position.x,
            position.y,
            merged.level as f32,
            held_slot.map_or(-1.0, |slot| slot as f32),
        ];
        if self.merge_events.len() == EVENT_WINDOW {
            self.merge_events.remove(0);
        }
        self.merge_events.push(self.last_merge);
        merged
    }

    fn collect_pairs(&mut self) {
        self.order.clear();
        self.order
            .extend((0..self.balls.len()).filter(|&index| !self.consumed[index]));
        self.order.sort_unstable_by(|&a, &b| {
            self.balls[a]
                .outline
                .bounds
                .min
                .x
                .total_cmp(&self.balls[b].outline.bounds.min.x)
                .then_with(|| a.cmp(&b))
        });
        self.pairs.clear();
        for (offset, &a) in self.order.iter().enumerate() {
            let bounds_a = self.balls[a].outline.bounds;
            for &b in &self.order[offset + 1..] {
                let bounds_b = self.balls[b].outline.bounds;
                if bounds_b.entirely_right_of(bounds_a) {
                    break;
                }
                if bounds_a.intersects(bounds_b) {
                    self.pairs.push((a.min(b), a.max(b)));
                }
            }
        }
        self.pairs.sort_unstable();
    }

    fn clear_separated_splits(&mut self) {
        for index in 0..self.balls.len() {
            let Some(other_id) = self.balls[index].separating_from else {
                continue;
            };
            let other = self.balls.iter().find(|ball| ball.identity.id == other_id);
            if other.is_none_or(|ball| {
                contact(&self.balls[index].outline, &ball.outline)
                    .is_none_or(|touch| touch.depth < 0.0)
            }) {
                self.balls[index].separating_from = None;
            }
        }
    }

    fn advance(&mut self) {
        if self.paused || self.ended {
            return;
        }
        self.tick = self.tick.saturating_add(1);
        self.advance_rack();
        self.pull_splashes();
        let (left, right) = self.walls();
        let mut collided = false;
        for ball in &mut self.balls {
            ball.integrate();
            collided |= ball.contain(left, right);
        }

        self.consumed.clear();
        self.consumed.resize(self.balls.len(), false);
        self.pending_merges.clear();
        collided |= self.resolve_rack_contacts();
        for _ in 0..SOLVER_PASSES {
            self.clear_separated_splits();
            self.collect_pairs();
            let pair_count = self.pairs.len();
            for &(a, b) in &self.pairs {
                if self.consumed[a] || self.consumed[b] {
                    continue;
                }
                let (before, after) = self.balls.split_at_mut(b);
                let first = &mut before[a];
                let second = &mut after[0];
                if let Some(touch) = contact(&first.outline, &second.outline) {
                    if second.can_be_absorbed_by(first, self.tick, touch) {
                        first.absorb(second);
                        self.consumed[b] = true;
                    } else if first.can_be_absorbed_by(second, self.tick, touch) {
                        second.absorb(first);
                        self.consumed[a] = true;
                    } else if first.identity.level == second.identity.level
                        && first.fragment.is_none()
                        && second.fragment.is_none()
                        && first.separating_from != Some(second.identity.id)
                        && second.separating_from != Some(first.identity.id)
                    {
                        if touch.depth >= 0.0 {
                            self.pending_merges.push((a, b));
                            self.consumed[a] = true;
                            self.consumed[b] = true;
                        }
                    } else {
                        collided |= resolve(first, second, touch);
                    }
                }
            }
            if pair_count == 0 {
                break;
            }
            for (index, ball) in self.balls.iter_mut().enumerate() {
                if !self.consumed[index] {
                    collided |= ball.contain(left, right);
                }
            }
        }

        self.finish_merges(left, right);
        self.refill();
        self.update_pressure();
        self.collision_cooldown = self.collision_cooldown.saturating_sub(1);
        if collided && self.collision_cooldown == 0 {
            self.collision_count = self.collision_count.saturating_add(1);
            self.collision_cooldown = 10;
        }
        self.launch_mask = self.unblocked_entries();
        self.evaluate_danger();
        self.write_snapshot();
    }

    fn finish_merges(&mut self, left: f32, right: f32) {
        for index in 0..self.pending_merges.len() {
            let (a, b) = self.pending_merges[index];
            let first = &self.balls[a];
            let second = &self.balls[b];
            let weight = first.mass / (first.mass + second.mass);
            let position = first.position * weight + second.position * (1.0 - weight);
            let velocity = first.velocity * weight + second.velocity * (1.0 - weight);
            let offset = second.position - first.position;
            let distance = offset.length();
            let axis = if distance > 0.01 {
                offset * distance.recip()
            } else {
                Point::X
            };
            let sources = [first.identity, second.identity];
            let core_area = first.area() + second.area();
            let identity = self.merge(sources[0], sources[1], position, None);
            let mut result = Ball::new(identity, position, velocity);
            let remaining_area = self.reparent_splashes(sources, identity, core_area);
            result.set_area(remaining_area);
            result.merge_shape(axis);
            result.project_inside(left, right);
            self.spawned.push(result);
        }
        if self.consumed.iter().any(|&consumed| consumed) {
            let mut index = 0;
            self.balls.retain(|_| {
                let alive = !self.consumed[index];
                index += 1;
                alive
            });
            self.balls.append(&mut self.spawned);
        }
    }

    fn update_pressure(&mut self) {
        let mut load = [0.0; 2];
        for ball in &self.balls {
            load[0] += ball.rail_load[0];
            load[1] += ball.rail_load[1];
        }
        for (pressure, load) in self.pressure.iter_mut().zip(load) {
            let response = if load > *pressure { 32.0 } else { 13.0 };
            *pressure =
                (*pressure + (load.min(1.3) - *pressure) * STEP_SECONDS * response).clamp(0.0, 1.0);
        }
        let (left, right) = self.walls();
        for ball in &mut self.balls {
            ball.project_inside(left, right);
        }
    }

    fn evaluate_danger(&mut self) {
        if self
            .pressure
            .iter()
            .all(|&pressure| pressure >= FULL_PRESSURE)
            && self.launch_mask == 0
        {
            self.danger_ticks += 1;
            self.ended = self.danger_ticks >= DANGER_CONFIRM_STEPS;
        } else {
            self.danger_ticks = 0;
        }
    }

    fn achievement_flags(&self, total_merges: u32) -> u32 {
        let mut flags = 0;
        for (index, earned) in [
            self.scored_merges >= 1,
            self.highest_level >= 7,
            self.highest_level >= 10,
            total_merges >= 100,
            self.highest_level >= 13,
        ]
        .into_iter()
        .enumerate()
        {
            flags |= u32::from(earned) << index;
        }
        flags
    }

    fn write_snapshot(&mut self) {
        let mut header = [0.0; SNAPSHOT_HEADER];
        header[0] = self.legal_launches() as f32;
        header[1] = self.highest_level as f32;
        header[2] = self.merges as f32;
        header[3] = self.shots as f32;
        header[4..6].copy_from_slice(&self.pressure);
        header[6] = self.danger_ticks as f32 * STEP_SECONDS;
        header[7] = u32::from(self.ended) as f32;
        header[11] = self.balls.len() as f32;
        header[12..16].copy_from_slice(&self.last_merge[..4]);
        header[16] = self.rack_merge.map_or(-1.0, |(slot, _)| slot as f32);
        header[17] = self.rack_merge.map_or(0.0, |(_, event)| event as f32);
        let centers = self.rack_centers();
        self.rack_hulls.fill(0.0);
        for (index, center) in centers.into_iter().enumerate() {
            header[RACK_LEVEL_OFFSETS[index]] =
                self.slots[index].map_or(0.0, |ball| ball.level as f32);
            header[RACK_ID_OFFSET + index] = self.slots[index].map_or(0.0, |ball| ball.id as f32);
            let entry = self.launch_entries[index];
            let entry_offset = RACK_ENTRY_OFFSETS[index];
            header[entry_offset] = entry.x;
            header[entry_offset + 1] = entry.y;
            let offset = RACK_CENTER_OFFSETS[index];
            header[offset] = center.x;
            header[offset + 1] = center.y;
            header[offset + 2] =
                self.slots[index].map_or(0.0, |ball| Self::held_radius(ball.level));
            if let Some(held) = self.slots[index] {
                let outline = self.rack_outline(index, held.level);
                let position = self.rack_position(index, center);
                let start = index * RACK_HULL_STRIDE;
                self.rack_hulls[start..start + 5].copy_from_slice(&[
                    position.x,
                    position.y,
                    outline.angle,
                    outline.radius_x,
                    outline.radius_y,
                ]);
                for (node, point) in outline.nodes.into_iter().enumerate() {
                    let offset = start + 5 + node * 2;
                    self.rack_hulls[offset] = point.x;
                    self.rack_hulls[offset + 1] = point.y;
                }
            }
        }
        self.snapshot.clear();
        self.snapshot.extend_from_slice(&header);
        for ball in &self.balls {
            self.snapshot.extend_from_slice(&[
                ball.identity.id as f32,
                ball.identity.level as f32,
                ball.position.x,
                ball.position.y,
                ball.outline.angle,
                ball.outline.radius_x,
                ball.outline.radius_y,
                ball.impact,
            ]);
            for point in ball.outline.nodes {
                self.snapshot.extend_from_slice(&[point.x, point.y]);
            }
            self.snapshot.extend_from_slice(&ball.surface_impact());
            self.snapshot.push(
                ball.fragment
                    .map_or(0.0, |piece| piece.owner.level as f32 + 1.0),
            );
        }
    }
}

thread_local! {
    static GAME: RefCell<Option<Game>> = const { RefCell::new(None) };
}

fn read<T>(fallback: T, f: impl FnOnce(&Game) -> T) -> T {
    GAME.with(|game| game.borrow().as_ref().map_or(fallback, f))
}

fn update<T>(fallback: T, f: impl FnOnce(&mut Game) -> T) -> T {
    GAME.with(|game| game.borrow_mut().as_mut().map_or(fallback, f))
}

#[unsafe(no_mangle)]
pub extern "C" fn reset(seed: u32) {
    GAME.with(|game| *game.borrow_mut() = Some(Game::new(seed)));
}

#[unsafe(no_mangle)]
pub extern "C" fn step() {
    update((), Game::advance);
}

#[unsafe(no_mangle)]
pub extern "C" fn launch(slot: u32, dx: f32, dy: f32, power: f32) -> u32 {
    update(0, |game| {
        u32::from(game.launch(slot as usize, Point::new(dx, dy), power))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn throw_drop(id: u32, dx: f32, dy: f32, power: f32) -> u32 {
    update(0, |game| {
        u32::from(game.throw_drop(id, Point::new(dx, dy), power))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn splash(id: u32, x: f32, y: f32) -> u32 {
    update(0, |game| game.splash(id, Point::new(x, y)))
}

#[unsafe(no_mangle)]
pub extern "C" fn can_launch(slot: u32) -> u32 {
    read(0, |game| {
        u32::from((slot as usize) < RACK_SLOTS && game.legal_launches() & (1 << slot) != 0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn set_paused(paused: u32) {
    update((), |game| {
        game.paused = paused != 0;
        game.write_snapshot();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn collision_event() -> u32 {
    read(0, |game| game.collision_count)
}

#[unsafe(no_mangle)]
pub extern "C" fn achievement_flags(total_merges: u32) -> u32 {
    read(0, |game| game.achievement_flags(total_merges))
}

#[unsafe(no_mangle)]
pub extern "C" fn scored_merges() -> u32 {
    read(0, |game| game.scored_merges)
}

#[unsafe(no_mangle)]
pub extern "C" fn merge_events_ptr() -> *const f32 {
    read(std::ptr::null(), |game| game.merge_events.as_ptr().cast())
}

#[unsafe(no_mangle)]
pub extern "C" fn merge_events_len() -> u32 {
    read(0, |game| {
        (game.merge_events.len() * MERGE_EVENT_SIZE) as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_merge_events() {
    update((), |game| game.merge_events.clear());
}

#[unsafe(no_mangle)]
pub extern "C" fn snapshot_ptr() -> *const f32 {
    read(std::ptr::null(), |game| game.snapshot.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn snapshot_len() -> u32 {
    read(0, |game| game.snapshot.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn rack_hulls_ptr() -> *const f32 {
    read(std::ptr::null(), |game| game.rack_hulls.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn score_ptr() -> *const u8 {
    read(std::ptr::null(), |game| game.score_text.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn score_len() -> u32 {
    read(0, |game| game.score_text.len() as u32)
}
