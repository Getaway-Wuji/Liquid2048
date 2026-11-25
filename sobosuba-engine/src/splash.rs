use std::f32::consts::{FRAC_PI_2, PI, TAU};

use crate::Game;
use crate::geometry::{Bounds, Outline, Point, contact};
use crate::physics::{Ball, BallId, FLOOR, GRAVITY, STEP_SECONDS, TOP, radius};

const TAP_WINDOW: u32 = 54;
const TAPS_TO_SPLIT: u8 = 3;
const SPURT_DELAY: u32 = 29;
const RETURN_ATTEMPT_TICKS: u32 = 420;
const MAX_FRAGMENTS: usize = 28;
const MIN_CORE_AREA: f32 = 121.0;
const OUTLET_ANGLES: [f32; 9] = [0.0, -0.28, 0.28, -0.61, 0.61, -1.03, 1.03, -1.57, 1.57];

#[derive(Clone, Copy)]
pub(crate) struct Fragment {
    pub owner: BallId,
    pub return_tick: u32,
    absorb_tick: u32,
    detour: Option<Detour>,
}

impl Fragment {
    pub(crate) fn new(owner: BallId, return_tick: u32) -> Self {
        Self {
            owner,
            return_tick,
            absorb_tick: return_tick.saturating_add(RETURN_ATTEMPT_TICKS),
            detour: None,
        }
    }

    pub(crate) fn can_change_owner(self, tick: u32) -> bool {
        tick >= self.absorb_tick
    }

    pub(crate) fn attached_to(self, owner: BallId, tick: u32) -> bool {
        self.owner == owner && !self.can_change_owner(tick)
    }
}

#[derive(Clone, Copy)]
struct Detour {
    obstacle: u32,
    side: f32,
}

fn route_limit(position: Point, bounds: Bounds, radius: f32) -> Point {
    Point::new(
        position
            .x
            .clamp(bounds.min.x + radius, bounds.max.x - radius),
        position
            .y
            .clamp(bounds.min.y + radius, bounds.max.y - radius),
    )
}

fn route_side_cost(
    side: f32,
    from: Point,
    to: Point,
    obstacle: Bounds,
    arena: Bounds,
    clearance: f32,
) -> f32 {
    let center = (obstacle.min + obstacle.max) * 0.5;
    let from = from - center;
    let to = to - center;
    let start = from.y.atan2(from.x);
    let sweep = ((to.y.atan2(to.x) - start) * side).rem_euclid(TAU);
    let wall_gaps = [
        (0.0, arena.max.x - obstacle.max.x),
        (FRAC_PI_2, arena.max.y - obstacle.max.y),
        (PI, obstacle.min.x - arena.min.x),
        (-FRAC_PI_2, obstacle.min.y - arena.min.y),
    ];
    // Check the entire arc, because a side with room for the first step can
    // still run into a wall before the fragment reaches the other end.
    let walls = wall_gaps
        .iter()
        .filter(|(angle, _)| ((angle - start) * side).rem_euclid(TAU) < sweep)
        .map(|(_, gap)| (2.0 * clearance - gap).max(0.0))
        .sum::<f32>();
    let diameter = obstacle.max - obstacle.min;
    sweep * (diameter.x + diameter.y) * 0.25 + walls * 12.0
}

fn near_edge(position: Point, hull: &Outline) -> (Point, f32) {
    let mut best = f32::INFINITY;
    let mut result = (Point::X, 0.0);
    for i in 0..hull.nodes.len() {
        let start = hull.nodes[i];
        let edge = hull.nodes[(i + 1) % hull.nodes.len()] - start;
        let from_edge = position - start;
        let closest = from_edge - edge * (from_edge.dot(edge) / edge.dot(edge)).clamp(0.0, 1.0);
        let distance = closest.dot(closest);
        if distance < best {
            best = distance;
            let outward = edge.perpendicular() * -edge.length().recip();
            let length = distance.sqrt();
            result = if closest.dot(outward) >= 0.0 && length > 0.001 {
                (closest * length.recip(), length)
            } else {
                (outward, -length)
            };
        }
    }
    result
}

// Clip the return line against the convex obstacle expanded by the shard's radius.
// The solver still handles all real collisions. This only anticipates a detour.
fn route_intercept(origin: Point, path: Point, clearance: f32, hull: &Outline) -> Option<f32> {
    let end = origin + path;
    let bounds = hull.bounds;
    if origin.x.min(end.x) > bounds.max.x + clearance
        || origin.x.max(end.x) < bounds.min.x - clearance
        || origin.y.min(end.y) > bounds.max.y + clearance
        || origin.y.max(end.y) < bounds.min.y - clearance
    {
        return None;
    }

    let mut enter: f32 = 0.0;
    let mut exit: f32 = 1.0;
    for (i, &start) in hull.nodes.iter().enumerate() {
        let edge = hull.nodes[(i + 1) % hull.nodes.len()] - start;
        let inward = edge.perpendicular();
        let inside = (origin - start).dot(inward) + clearance * edge.length();
        let slope = path.dot(inward);
        if slope > 0.0001 {
            enter = enter.max(-inside / slope);
        } else if slope < -0.0001 {
            exit = exit.min(-inside / slope);
        } else if inside < 0.0 {
            return None;
        }
        if enter >= exit {
            return None;
        }
    }

    if enter <= 0.0001 && near_edge(origin, hull).0.dot(path) > 0.0 {
        return None;
    }
    Some(enter)
}

#[derive(Default)]
pub(crate) struct TapSeries {
    last_tick: u32,
    count: u8,
}

impl TapSeries {
    fn register(&mut self, tick: u32) -> u8 {
        self.count = if tick.saturating_sub(self.last_tick) <= TAP_WINDOW {
            self.count.saturating_add(1)
        } else {
            1
        };
        self.last_tick = tick;
        self.count
    }
}

impl Game {
    pub(crate) fn splash(&mut self, id: u32, tap: Point) -> u32 {
        if self.paused || self.ended || !tap.x.is_finite() || !tap.y.is_finite() {
            return 0;
        }
        let Some(hit) = self.balls.iter().find(|ball| ball.identity.id == id) else {
            return 0;
        };
        let owner = hit.fragment.map_or(hit.identity, |piece| piece.owner);
        let Some(center) = self.balls.iter().position(|ball| ball.identity == owner) else {
            return 0;
        };
        let streak = self.balls[center].tap_series.register(self.tick);
        let pending_area = self
            .balls
            .iter()
            .filter(|ball| {
                ball.fragment
                    .is_some_and(|piece| piece.attached_to(owner, self.tick))
            })
            .map(Ball::area)
            .sum::<f32>();

        let direction = self.balls[center].position - tap;
        let turn = direction.y.atan2(direction.x) + TAU * self.splash_random();
        if streak >= TAPS_TO_SPLIT && self.split_drop(center, turn) {
            self.write_snapshot();
            return 2;
        }
        if pending_area > 0.0 && streak > 1 {
            let speed = 48.0 + self.splash_random() * 42.0;
            self.fan_fragments(center, speed);
        } else {
            let count = 3 + usize::from(self.splash_random() < 0.5);
            let area = self.balls[center].area();
            // Make room for another splash without leaving the numbered body
            // smaller than the liquid it still has to draw back in.
            let mut available = area - MIN_CORE_AREA.max((area + pending_area) * 0.55);
            let mut emitted = false;
            for index in 0..count {
                let angle =
                    turn + (index as f32 + 0.32 * self.splash_random()) * TAU / count as f32;
                let portion = (area * (0.064 + self.splash_random() * 0.008)).min(available);
                let speed = 310.0 + self.splash_random() * 85.0;
                if portion < 4.0 {
                    break;
                }
                if self.send_fragment(center, angle, portion, speed) {
                    available -= portion;
                    emitted = true;
                }
            }
            if !emitted {
                let (y, x) = turn.sin_cos();
                self.balls[center].press_surface(Point::new(x, y));
            }
        }
        self.write_snapshot();
        1
    }

    fn splash_random(&mut self) -> f32 {
        let rng = &mut self.splash_rng;
        *rng ^= *rng << 13;
        *rng ^= *rng >> 17;
        *rng ^= *rng << 5;
        (*rng >> 8) as f32 / 16_777_216.0
    }

    fn split_drop(&mut self, center: usize, turn: f32) -> bool {
        let body = &self.balls[center];
        let original = body.identity;
        if original.level <= 1 {
            return false;
        }
        let level = original.level - 1;
        let Some((probe, direction)) = self.splash_outlet(center, turn, body.area() * 0.5) else {
            return false;
        };
        let fragments: Vec<_> = self
            .balls
            .iter()
            .enumerate()
            .filter(|(_, ball)| {
                ball.fragment
                    .is_some_and(|piece| piece.attached_to(original, self.tick))
            })
            .collect();
        let fragment_area: f32 = fragments.iter().map(|(_, ball)| ball.area()).sum();
        let half_area = (body.area() + fragment_area) * 0.5;
        let mut main_area = half_area;
        let mut new_area = half_area;
        let mut assignments = Vec::with_capacity(fragments.len());
        for (index, piece) in fragments {
            let portion = piece.area();
            let near_main = piece.position - body.position;
            let near_new = piece.position - probe;
            let fits_main = main_area - portion >= half_area * 0.2;
            let fits_new = new_area - portion >= half_area * 0.2;
            if !fits_main && !fits_new {
                return false;
            }
            let follows_new =
                fits_new && (!fits_main || near_new.dot(near_new) < near_main.dot(near_main));
            if follows_new {
                new_area -= portion;
            } else {
                main_area -= portion;
            }
            assignments.push((index, follows_new));
        }
        let turn = direction.y.atan2(direction.x);
        let Some((position, direction)) = self.splash_outlet(center, turn, new_area) else {
            return false;
        };
        let velocity = body.velocity;
        let body_area = body.area();
        let main_id = BallId { level, ..original };
        let new_id = BallId {
            id: self.body_id(level).id,
            ..main_id
        };
        let kick = direction * 310.0;
        let mut new_drop = Ball::new(new_id, position, velocity + kick * (main_area / body_area));
        new_drop.set_area(new_area);
        new_drop.separating_from = Some(main_id.id);
        let main = &mut self.balls[center];
        main.identity = main_id;
        main.velocity -= kick * (new_area / body_area);
        main.set_area(main_area);
        main.tap_series = TapSeries::default();
        for (index, follows_new) in assignments {
            let piece = self.balls[index].fragment.as_mut().expect("split splash");
            piece.owner = if follows_new { new_id } else { main_id };
            piece.return_tick = self.tick;
            piece.detour = None;
        }
        self.balls.push(new_drop);
        true
    }

    fn send_fragment(&mut self, center: usize, turn: f32, area: f32, speed: f32) -> bool {
        if self
            .balls
            .iter()
            .filter(|ball| ball.fragment.is_some())
            .count()
            >= MAX_FRAGMENTS
        {
            return false;
        }
        let Some((origin, direction)) = self.splash_outlet(center, turn, area) else {
            return false;
        };
        let owner = self.balls[center].identity;
        let kick = direction * speed;
        let velocity = self.balls[center].velocity + kick;
        let mut piece = Ball::new(self.body_id(0), origin, velocity);
        piece.set_area(area);
        piece.fragment = Some(Fragment::new(owner, self.tick.saturating_add(SPURT_DELAY)));
        let core = &mut self.balls[center];
        let retained = core.area() - area;
        core.velocity -= kick * (area / retained);
        core.set_area(retained);
        self.balls.push(piece);
        true
    }

    fn splash_outlet(&self, center: usize, turn: f32, area: f32) -> Option<(Point, Point)> {
        let core = &self.balls[center];
        let shrink = (1.0 - area / core.area()).sqrt();
        let radius = area.sqrt();
        let (left, right) = self.walls();
        let rack: [Option<Outline>; 3] = std::array::from_fn(|slot| {
            self.slots[slot].map(|held| self.rack_outline(slot, held.level))
        });
        // Search the surface nearest the splash direction first. The second pass
        // starts closer to the core, where two constricted lobes can separate safely.
        for extension in [0.79, 0.41] {
            for offset in OUTLET_ANGLES {
                let (dy, dx) = (turn + offset).sin_cos();
                let along = Point::new(dx, dy);
                let edge = core.outline.interval(along).1 - core.position.dot(along);
                let position = core.position + along * (edge * shrink + radius * extension);
                let probe = Outline::new(position, radius, Point::default());
                if probe.bounds.min.x < left
                    || probe.bounds.max.x > right
                    || probe.bounds.min.y < TOP
                    || probe.bounds.max.y > FLOOR
                {
                    continue;
                }
                let nearby = self
                    .balls
                    .iter()
                    .enumerate()
                    .filter_map(|(index, ball)| (index != center).then_some(&ball.outline));
                if nearby.chain(rack.iter().flatten()).all(|other| {
                    !probe.bounds.intersects(other.bounds)
                        || contact(&probe, other).is_none_or(|touch| touch.depth < radius * 0.30)
                }) {
                    return Some((position, along));
                }
            }
        }
        None
    }

    fn fan_fragments(&mut self, center: usize, speed: f32) {
        let id = self.balls[center].identity;
        let position = self.balls[center].position;
        let mut momentum = Point::default();
        for ball in &mut self.balls {
            let Some(piece) = ball
                .fragment
                .as_mut()
                .filter(|piece| piece.attached_to(id, self.tick))
            else {
                continue;
            };
            let offset = ball.position - position;
            let impulse = offset * (speed / offset.length().max(1.0));
            ball.velocity += impulse;
            momentum += impulse * ball.mass;
            piece.return_tick = self.tick.saturating_add(SPURT_DELAY);
            piece.detour = None;
        }
        let core = &mut self.balls[center];
        core.velocity -= momentum * core.mass.recip();
    }

    pub(crate) fn pull_splashes(&mut self) {
        let (left, right) = self.walls();
        let bounds = Bounds {
            min: Point::new(left, TOP),
            max: Point::new(right, FLOOR),
        };
        let mut rack = None;
        for index in 0..self.balls.len() {
            let Some(fragment) = self.balls[index].fragment else {
                continue;
            };
            let can_change_owner = fragment.can_change_owner(self.tick);
            if !can_change_owner && self.tick < fragment.return_tick {
                continue;
            }
            let position = self.balls[index].position;
            let target = if can_change_owner {
                self.balls
                    .iter()
                    .enumerate()
                    .filter(|(_, ball)| ball.fragment.is_none())
                    .min_by(|(_, a), (_, b)| {
                        let a = a.position - position;
                        let b = b.position - position;
                        a.dot(a).total_cmp(&b.dot(b))
                    })
                    .map(|(index, _)| index)
            } else {
                self.balls
                    .iter()
                    .position(|ball| ball.identity == fragment.owner)
            };
            let Some(owner) = target else { continue };
            let (elasticity, detour) = if can_change_owner {
                let piece = &self.balls[index];
                let core = &self.balls[owner];
                (
                    ((core.position - piece.position) * 15.0
                        - (piece.velocity - core.velocity) * 4.2
                        - Point::Y * GRAVITY)
                        .limited(2400.0),
                    None,
                )
            } else {
                let rack = rack.get_or_insert_with(|| {
                    std::array::from_fn(|slot| {
                        self.slots[slot].map(|held| (held.id, self.rack_outline(slot, held.level)))
                    })
                });
                self.splash_return(index, owner, fragment, bounds, rack)
            };
            let [piece, core] = self
                .balls
                .get_disjoint_mut([index, owner])
                .expect("different splash bodies");
            piece.fragment.as_mut().expect("returning splash").detour = detour;
            let impulse = elasticity * STEP_SECONDS;
            let total = piece.mass + core.mass;
            piece.velocity += impulse * (core.mass / total);
            core.velocity -= impulse * (piece.mass / total);
        }
    }

    fn splash_return(
        &self,
        index: usize,
        owner: usize,
        fragment: Fragment,
        bounds: Bounds,
        rack: &[Option<(u32, Outline)>; 3],
    ) -> (Point, Option<Detour>) {
        let piece = &self.balls[index];
        let core = &self.balls[owner];
        let offset = core.position - piece.position;
        let direct = offset * 15.0 - (piece.velocity - core.velocity) * 4.2;
        let distance = offset.length();
        let clearance = piece.area().sqrt() * 0.90 + 1.1;
        let path = offset * (1.0 - core.area().sqrt() * 0.55 / distance.max(1.0)).max(0.0);
        let approach = 30.0 + clearance * 2.0 + piece.velocity.length() * 0.075;
        let (obstacle, outline) = match self
            .balls
            .iter()
            .enumerate()
            .filter(|(i, ball)| {
                *i != index
                    && *i != owner
                    && ball
                        .fragment
                        .is_none_or(|part| part.owner != fragment.owner)
            })
            .map(|(_, ball)| (ball.identity.id, &ball.outline))
            .chain(rack.iter().flatten().map(|(id, outline)| (*id, outline)))
            .filter_map(|(id, outline)| {
                let fraction = route_intercept(piece.position, path, clearance, outline)?;
                (fraction * distance <= approach).then_some((fraction, id, outline))
            })
            .min_by(|(a, _, _), (b, _, _)| a.total_cmp(b))
        {
            Some((_, id, outline)) => (id, outline),
            None => return (direct.limited(1450.0), None),
        };

        let (outward, gap) = near_edge(piece.position, outline);
        let along = outward.perpendicular();
        let lookahead = 23.0 + clearance;
        let radial = outward * (clearance - gap).clamp(-lookahead, lookahead);
        let sample = |sign| piece.position + radial + along * (lookahead * sign);
        let side = fragment
            .detour
            .filter(|detour| detour.obstacle == obstacle)
            .map_or_else(
                || {
                    let cost = |side| {
                        let point = sample(side);
                        route_side_cost(
                            side,
                            piece.position,
                            core.position,
                            outline.bounds,
                            bounds,
                            clearance,
                        ) + (route_limit(point, bounds, clearance) - point).length() * 9.0
                    };
                    if cost(1.0) <= cost(-1.0) { 1.0 } else { -1.0 }
                },
                |detour| detour.side,
            );
        let waypoint = route_limit(sample(side), bounds, clearance);
        let velocity = ((waypoint - piece.position) * 8.0).limited(185.0);
        // Return force offsets gravity while a shard is climbing a wetted edge.
        // The equal reaction below is still applied to the receiving liquid.
        let steering = ((velocity - piece.velocity) * 15.0 - Point::Y * GRAVITY).limited(3400.0);
        (steering, Some(Detour { obstacle, side }))
    }

    pub(crate) fn reparent_splashes(
        &mut self,
        sources: [BallId; 2],
        owner: BallId,
        core_area: f32,
    ) -> f32 {
        let combined = radius(owner.level).powi(2);
        let tick = self.tick;
        let fragments = |ball: &Ball| {
            ball.fragment.is_some_and(|piece| {
                !piece.can_change_owner(tick) && sources.contains(&piece.owner)
            })
        };
        let fragment_area: f32 = self
            .balls
            .iter()
            .zip(&self.consumed)
            .filter(|(ball, consumed)| !**consumed && fragments(ball))
            .map(|(ball, _)| ball.area())
            .sum();
        let scale = combined / (core_area + fragment_area);
        for (ball, _) in self
            .balls
            .iter_mut()
            .zip(&self.consumed)
            .filter(|(ball, consumed)| !**consumed && fragments(ball))
        {
            let piece = ball.fragment.as_mut().expect("merged splash");
            piece.owner = owner;
            piece.detour = None;
            ball.set_area(ball.area() * scale);
        }
        core_area * scale
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_on_floor(game: &mut Game, level: u32, x: f32) -> BallId {
        let id = game.identity(level);
        game.balls.push(Ball::new(
            id,
            Point::new(x, FLOOR - radius(level)),
            Point::default(),
        ));
        id
    }

    fn area(game: &Game) -> f32 {
        game.balls.iter().map(Ball::area).sum()
    }

    #[test]
    fn splattered_drops_keep_their_area_and_push_a_neighbor() {
        let mut game = Game::new(5);
        let core = put_on_floor(&mut game, 1, 266.0);
        let neighbor = put_on_floor(&mut game, 2, 332.0);
        for _ in 0..24 {
            game.advance();
        }
        let initial_area = area(&game);
        let initial_neighbor_x = game.balls[1].position.x;
        assert_eq!(game.splash(core.id, game.balls[0].position), 1);
        assert!(
            game.balls
                .iter()
                .filter(|ball| ball.fragment.is_some())
                .count()
                >= 2
        );
        assert!((area(&game) - initial_area).abs() < 0.005);
        let mut neighbor_speed = 0.0_f32;
        let mut neighbor_shift = 0.0_f32;
        let mut close_fragment = false;
        for _ in 0..90 {
            game.advance();
            let nearby = game
                .balls
                .iter()
                .find(|body| body.identity == neighbor)
                .unwrap();
            neighbor_speed = neighbor_speed.max(nearby.velocity.x);
            neighbor_shift = neighbor_shift.max((nearby.position.x - initial_neighbor_x).abs());
            close_fragment |= game.balls.iter().any(|body| {
                body.fragment.is_some()
                    && (body.position - nearby.position).length()
                        <= body.area().sqrt() + radius(2) + 2.0
            });
        }
        assert!(
            close_fragment && neighbor_speed > 1.0,
            "did not share a physical impulse: {close_fragment}, {neighbor_speed}"
        );
        assert!(
            neighbor_shift > 1.0,
            "neighbor shift {neighbor_shift}, impulse speed {neighbor_speed}"
        );
        assert_eq!(game.score_text, "0");
        assert!((area(&game) - initial_area).abs() < 0.005);
    }

    #[test]
    fn repeated_clicks_halves_the_number_and_its_total_material_without_scoring() {
        let mut game = Game::new(11);
        let core = put_on_floor(&mut game, 2, 320.0);
        for _ in 0..35 {
            game.advance();
        }
        let initial_area = area(&game);
        let before_rng = game.rng;
        for expected in [1, 1] {
            assert_eq!(game.splash(core.id, game.balls[0].position), expected);
            for _ in 0..9 {
                game.advance();
            }
        }
        let total_momentum = |game: &Game| {
            game.balls.iter().fold(Point::default(), |sum, body| {
                sum + body.velocity * body.mass
            })
        };
        let momentum = total_momentum(&game);
        assert_eq!(game.splash(core.id, game.balls[0].position), 2);
        let split: Vec<_> = game
            .balls
            .iter()
            .filter(|body| body.fragment.is_none())
            .collect();
        assert_eq!(split.len(), 2);
        assert_eq!(split[0].identity.id, core.id);
        assert_ne!(split[0].identity.id, split[1].identity.id);
        for half in split {
            assert_eq!(half.identity.level, 1);
            assert_eq!(half.identity.score_ceiling, 2);
            let scattered_area: f32 = game
                .balls
                .iter()
                .filter(|body| {
                    body.fragment
                        .is_some_and(|piece| piece.owner == half.identity)
                })
                .map(Ball::area)
                .sum();
            assert!((half.area() + scattered_area - initial_area * 0.5).abs() < 0.005);
        }
        assert!((total_momentum(&game) - momentum).length() < 0.005);
        assert!((area(&game) - initial_area).abs() < 0.005);
        assert_eq!(game.rng, before_rng);
        assert_eq!(game.score_text, "0");
        assert_eq!(game.shots, 0);
    }

    #[test]
    fn a_split_drop_can_merge_with_any_matching_number() {
        let mut game = Game::new(11);
        let original = put_on_floor(&mut game, 3, 290.0);
        assert!(game.split_drop(0, 0.0));
        let other_half = game.balls[1].identity;
        assert_eq!(
            game.balls[0].identity,
            BallId {
                level: 2,
                ..original
            }
        );
        assert_eq!(other_half.level, 2);
        let y = game.balls[0].position.y;
        let x = game.balls[0].position.x - game.balls[0].area().sqrt() - radius(2) + 1.0;
        let matching = game.identity(2);
        game.balls
            .push(Ball::new(matching, Point::new(x, y), Point::X * 20.0));
        game.advance();
        assert!(game.balls.iter().any(|body| body.identity == other_half));
        assert!(game.balls.iter().any(|body| body.identity.level == 3));
        assert_eq!(game.balls.len(), 2);
        assert_eq!(game.score_text, "4");
        assert_eq!(game.scored_merges, 1);
    }

    #[test]
    fn repeated_split_and_rebuild_cannot_farm_score_or_count_for_achievements() {
        let mut game = Game::new(11);
        let original = game.identity(2);
        game.balls.push(Ball::new(
            original,
            Point::new(300.0, 500.0),
            Point::default(),
        ));
        for merges in 1..=5 {
            assert!(game.split_drop(0, 0.0));
            for _ in 0..12 {
                game.advance();
            }
            assert_eq!(game.balls.len(), 2);
            assert!(game.balls[1].separating_from.is_none());
            for (index, ball) in game.balls.iter_mut().enumerate() {
                ball.move_by(Point::new(300.0 + 39.0 * index as f32, 500.0) - ball.position);
                ball.velocity = Point::default();
            }
            game.advance();
            assert_eq!(game.balls.len(), 1);
            assert_eq!(game.balls[0].identity.level, 2);
            assert_eq!(game.merges, merges);
            assert_eq!(game.scored_merges, 0);
            assert_eq!(game.score_text, "0");
            assert_eq!(game.achievement_flags(game.scored_merges), 0);
        }
    }

    #[test]
    fn different_splits_cannot_score_by_pairing_with_each_others_halves() {
        let mut game = Game::new(11);
        for x in [140.0, 440.0] {
            let id = game.identity(3);
            game.balls
                .push(Ball::new(id, Point::new(x, 500.0), Point::default()));
        }
        assert!(game.split_drop(0, 0.0));
        assert!(game.split_drop(1, 0.0));
        // The original bodies are indices 0 and 1. Their new halves are 2 and 3.
        for (ball, x) in game.balls.iter_mut().zip([275.0, 140.0, 520.0, 319.0]) {
            ball.move_by(Point::new(x, 500.0) - ball.position);
            ball.velocity = Point::default();
        }
        game.advance();
        assert_eq!(game.balls.len(), 3);
        assert_eq!(
            game.balls
                .iter()
                .filter(|ball| ball.identity.level == 3)
                .count(),
            1
        );
        assert_eq!(game.merges, 1);
        assert_eq!(game.scored_merges, 0);
        assert_eq!(game.score_text, "0");
    }

    #[test]
    fn two_can_splash_but_cannot_split_further() {
        let mut game = Game::new(11);
        let two = put_on_floor(&mut game, 1, 320.0);
        for _ in 0..6 {
            assert_eq!(game.splash(two.id, game.balls[0].position), 1);
        }
        assert_eq!(
            game.balls
                .iter()
                .filter(|body| body.fragment.is_none())
                .count(),
            1
        );
        let (bodies, remainder) =
            game.snapshot[crate::SNAPSHOT_HEADER..].as_chunks::<{ crate::SNAPSHOT_BALL }>();
        assert!(remainder.is_empty());
        assert!(bodies.len() > 1);
        for (index, body) in bodies.iter().enumerate() {
            assert_eq!(body[1], if index == 0 { 1.0 } else { 0.0 });
            assert_eq!(
                body[crate::SNAPSHOT_BALL - 1],
                if index == 0 { 0.0 } else { 2.0 }
            );
        }
    }

    #[test]
    fn merging_a_splashed_number_transfers_its_physical_fragments() {
        let mut game = Game::new(42);
        let core = put_on_floor(&mut game, 2, 304.0);
        assert_eq!(game.splash(core.id, game.balls[0].position), 1);
        assert!(game.balls.len() > 1);
        put_on_floor(&mut game, 2, 353.0);
        game.advance();
        assert_eq!(game.merges, 1);
        assert_eq!(game.score_text, "8");
        let result = game
            .balls
            .iter()
            .find(|ball| ball.fragment.is_none())
            .unwrap()
            .identity;
        assert_eq!(result.level, 3);
        assert!(game.balls.iter().any(|ball| ball.fragment.is_some()));
        assert!(
            game.balls
                .iter()
                .all(|ball| ball.fragment.is_none_or(|part| part.owner == result))
        );
        assert!((area(&game) - radius(3).powi(2)).abs() < 0.005);
        for _ in 0..420 {
            game.advance();
        }
        assert_eq!(game.balls.len(), 1);
        assert_eq!(game.score_text, "8");
    }

    #[test]
    fn rejoining_a_fragment_before_merging_does_not_subtract_its_volume_twice() {
        let mut game = Game::new(3);
        let core = put_on_floor(&mut game, 1, 300.0);
        let area = game.balls[0].area() * 0.25;
        game.balls[0].set_area(area * 3.0);
        let mut piece = Ball::new(
            game.body_id(0),
            Point::new(283.0, FLOOR - radius(1)),
            Point::default(),
        );
        piece.set_area(area);
        piece.fragment = Some(Fragment::new(core, 0));
        game.balls.push(piece);
        put_on_floor(&mut game, 1, 340.0);
        game.advance();
        assert_eq!(game.balls.len(), 1);
        assert_eq!(game.score_text, "4");
        assert!(game.balls[0].is_whole());
    }

    #[test]
    fn returning_splashes_climb_around_a_floor_obstacle() {
        let mut game = Game::new(13);
        let core = put_on_floor(&mut game, 1, 211.0);
        let blocker = put_on_floor(&mut game, 5, 321.0);
        for _ in 0..100 {
            game.advance();
        }
        let original = game.balls[0].area();
        let portion = original * 0.095;
        game.balls[0].set_area(original - portion);
        let id = game.body_id(0);
        let mut shard = Ball::new(
            id,
            Point::new(419.0, FLOOR - portion.sqrt()),
            Point::default(),
        );
        shard.set_area(portion);
        shard.fragment = Some(Fragment::new(core, 0));
        game.balls.push(shard);
        let initial_area = area(&game);

        let mut crossed_high = false;
        for _ in 0..720 {
            game.advance();
            let Some(shard) = game.balls.iter().find(|body| body.identity == id) else {
                break;
            };
            let obstacle = game
                .balls
                .iter()
                .find(|body| body.identity == blocker)
                .unwrap();
            crossed_high |= (shard.position.x - obstacle.position.x).abs() < 10.0
                && shard.position.y < obstacle.outline.bounds.min.y;
        }

        assert!(
            crossed_high,
            "the shard did not pass above the blocking outline"
        );
        assert_eq!(game.balls.len(), 2);
        assert!(
            game.balls
                .iter()
                .find(|body| body.identity == core)
                .unwrap()
                .is_whole()
        );
        assert!((area(&game) - initial_area).abs() < 0.005);
        assert_eq!(game.score_text, "0");
    }

    #[test]
    fn returning_splashes_follow_the_outer_edge_of_two_touching_obstacles() {
        let mut game = Game::new(15);
        let core = put_on_floor(&mut game, 1, 171.0);
        let first = put_on_floor(&mut game, 5, 295.0);
        let second = put_on_floor(&mut game, 4, 399.0);
        for _ in 0..100 {
            game.advance();
        }
        let original = game.balls[0].area();
        let portion = original * 0.095;
        game.balls[0].set_area(original - portion);
        let id = game.body_id(0);
        let mut shard = Ball::new(
            id,
            Point::new(470.0, FLOOR - portion.sqrt()),
            Point::default(),
        );
        shard.set_area(portion);
        shard.fragment = Some(Fragment::new(core, 0));
        game.balls.push(shard);

        let mut passed = [false; 2];
        for _ in 0..900 {
            game.advance();
            let Some(shard) = game.balls.iter().find(|body| body.identity == id) else {
                break;
            };
            for (passed, obstacle_id) in passed.iter_mut().zip([first, second]) {
                let obstacle = game
                    .balls
                    .iter()
                    .find(|body| body.identity == obstacle_id)
                    .unwrap();
                *passed |= (shard.position.x - obstacle.position.x).abs() < 10.0
                    && shard.position.y < obstacle.outline.bounds.min.y;
            }
        }
        assert_eq!(passed, [true, true]);
        assert_eq!(game.balls.len(), 3);
        assert!(game.balls[0].is_whole());
    }
}
