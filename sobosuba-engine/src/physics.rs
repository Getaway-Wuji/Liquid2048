use crate::geometry::{Contact, NODE_COUNT, Outline, Point};
use crate::splash::{Fragment, TapSeries};

pub const STEP_SECONDS: f32 = 1.0 / 120.0;
pub const GRAVITY: f32 = 1120.0;
pub const SPEED_MIN: f32 = 150.0;
pub const SPEED_RANGE: f32 = 1220.0;
pub const LEFT: f32 = 32.0;
pub const RIGHT: f32 = 608.0;
pub const TOP: f32 = 8.0;
pub const FLOOR: f32 = 676.0;
pub const RAIL_TRAVEL: f32 = 18.0;
pub const FULL_PRESSURE: f32 = 0.985;
const MAX_SPEED: f32 = 1500.0;
const MAX_STRAIN: f32 = 0.55;
const MAX_LAUNCH_STRAIN: f32 = 0.86;
const TOUCH_SOUND_SPEED: f32 = 205.0;

pub fn launch_speed(power: f32) -> f32 {
    SPEED_MIN + SPEED_RANGE * power * (0.42 + 0.58 * power)
}

pub fn radius(level: u32) -> f32 {
    const RADII: [f32; 12] = [
        24.0, 30.0, 37.0, 45.0, 54.0, 64.0, 75.0, 86.0, 97.0, 107.0, 116.0, 124.0,
    ];
    let index = level.saturating_sub(1) as usize;
    RADII.get(index).copied().unwrap_or_else(|| {
        let extra = (index - RADII.len() + 1) as f32;
        154.0 - 30.0 / (1.0 + 0.16 * extra)
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BallId {
    pub id: u32,
    pub level: u32,
    /// Highest value level already covered for scoring by this drop's material.
    pub score_ceiling: u32,
}

impl BallId {
    pub fn new(id: u32, level: u32) -> Self {
        Self {
            id,
            level,
            score_ceiling: level,
        }
    }
}

#[derive(Default)]
struct SurfaceDent {
    facing: Point,
    depth: f32,
    speed: f32,
    half_width: f32,
}

impl SurfaceDent {
    fn frequency(radius: f32) -> f32 {
        10.8 * (46.0 / radius.clamp(30.0, 116.0)).sqrt()
    }

    fn strike(&mut self, facing: Point, depth: f32, half_width: f32, radius: f32) {
        let same_face = self.facing.dot(facing) > 0.7;
        if !same_face {
            // Keep a stronger indentation if another part receives a glancing touch.
            if depth < self.depth.abs() {
                return;
            }
            self.depth = 0.0;
            self.speed = 0.0;
        }
        self.facing = facing;
        self.half_width = half_width;
        self.depth = self.depth.max(depth * 0.30);
        self.speed = self.speed.max(depth * Self::frequency(radius) * 1.45);
    }

    fn advance(&mut self, radius: f32) {
        if self.half_width == 0.0 {
            return;
        }
        let frequency = Self::frequency(radius);
        self.speed -=
            (self.depth * frequency.powi(2) + self.speed * frequency * 1.14) * STEP_SECONDS;
        self.depth += self.speed * STEP_SECONDS;
        if self.depth.abs() < 0.03 && self.speed.abs() < 0.28 {
            *self = Self::default();
        }
    }
}

pub struct Ball {
    pub identity: BallId,
    pub position: Point,
    pub velocity: Point,
    pub outline: Outline,
    pub impact: f32,
    pub rail_load: [f32; 2],
    pub mass: f32,
    pub fragment: Option<Fragment>,
    pub separating_from: Option<u32>,
    pub tap_series: TapSeries,
    radius: f32,
    softness: f32,
    drag: f32,
    strain: Point,
    strain_velocity: Point,
    pressure: [f32; NODE_COUNT],
    elastic_recoil: f32,
    surface_dent: SurfaceDent,
    launch_charge: f32,
}

impl Ball {
    pub fn new(identity: BallId, position: Point, velocity: Point) -> Self {
        let radius = radius(identity.level);
        let relative = radius / 24.0;
        Self {
            identity,
            position,
            velocity,
            outline: Outline::new(position, radius, Point::default()),
            impact: 0.0,
            rail_load: [0.0; 2],
            mass: relative * relative,
            fragment: None,
            separating_from: None,
            tap_series: TapSeries::default(),
            radius,
            softness: 0.64 + 0.36 / relative,
            drag: 0.09 + 0.19 / relative,
            strain: Point::default(),
            strain_velocity: Point::default(),
            pressure: [0.0; NODE_COUNT],
            elastic_recoil: 0.0,
            surface_dent: SurfaceDent::default(),
            launch_charge: 0.0,
        }
    }

    pub fn area(&self) -> f32 {
        self.radius * self.radius
    }

    pub fn surface_impact(&self) -> [f32; 4] {
        let dent = &self.surface_dent;
        [dent.facing.x, dent.facing.y, dent.depth, dent.half_width]
    }

    fn record_surface_impact(
        &mut self,
        striker: &Self,
        normal: Point,
        reaction: f32,
        striker_share: f32,
    ) {
        let force = ((reaction - 125.0) / 775.0).clamp(0.0, 1.0);
        if force == 0.0 || self.fragment.is_some() || striker.fragment.is_some() {
            return;
        }
        let offset = striker.position - self.position;
        let center_line = offset * offset.length().max(1.0).recip();
        let facing = normal * 0.25 + center_line * 0.75;
        let facing = facing * facing.length().max(0.001).recip();
        let footprint = striker.radius.clamp(self.radius * 0.28, self.radius * 0.82);
        let depth = (self.radius * 0.26 + footprint * 0.23).min(36.0)
            * force
            * (0.47 + striker_share * 0.53);
        self.surface_dent
            .strike(facing, depth, footprint * 1.38, self.radius);
    }

    pub fn set_area(&mut self, area: f32) {
        self.radius = area.sqrt();
        let relative = self.radius / 24.0;
        self.mass = area / (24.0 * 24.0);
        self.softness = 0.64 + 0.36 / relative.max(0.52);
        self.drag = 0.09 + 0.19 / relative.max(0.38);
        self.update_outline();
    }

    #[cfg(test)]
    pub fn is_whole(&self) -> bool {
        self.area() >= radius(self.identity.level).powi(2) * 0.999
    }

    pub fn can_be_absorbed_by(&self, other: &Self, tick: u32, contact: Contact) -> bool {
        other.fragment.is_none()
            && self.fragment.is_some_and(|piece| {
                (piece.can_change_owner(tick) && contact.depth >= 0.0)
                    || (tick >= piece.return_tick && piece.owner == other.identity)
            })
    }

    pub fn absorb(&mut self, piece: &Self) {
        let weight = piece.mass / (self.mass + piece.mass);
        self.position += (piece.position - self.position) * weight;
        self.velocity += (piece.velocity - self.velocity) * weight;
        self.set_area(self.area() + piece.area());
    }

    pub fn press_surface(&mut self, direction: Point) {
        self.squeeze(direction, self.radius * 0.08, 36.0, 0.01);
    }

    fn update_outline(&mut self) {
        self.outline =
            Outline::with_pressure(self.position, self.radius, self.strain, &self.pressure);
    }

    pub fn move_by(&mut self, delta: Point) {
        self.position += delta;
        self.outline.translate(delta);
    }

    pub fn launch_stretch(&mut self) {
        let speed = self.velocity.length();
        let direction = self.velocity * speed.max(1.0).recip();
        self.strain = direction.double_angle() * (speed / launch_speed(1.0) * 0.19);
        self.strain_velocity = direction.double_angle() * 0.16;
        self.update_outline();
    }

    pub fn set_launch_power(&mut self, power: f32) {
        self.launch_charge = power.powi(2);
    }

    pub fn narrow_launch(&mut self, half_width: f32) {
        if half_width > 0.0 && half_width < self.radius {
            let compression = (self.radius / half_width).ln().min(MAX_STRAIN);
            self.strain = Point::X * -compression;
            self.strain_velocity = Point::X * -0.16;
            self.update_outline();
        }
    }

    pub fn merge_shape(&mut self, axis: Point) {
        self.strain = axis.double_angle() * 0.19;
        self.strain_velocity = axis.double_angle() * 0.7;
        self.elastic_recoil = 0.64;
        self.impact = 0.74;
        self.update_outline();
    }

    fn recover_shape(&mut self, target: Point, mounted: bool) {
        // Surface tension pulls the displaced liquid back through equilibrium.
        // The same disturbance travels farther around the larger droplets.
        let frequency = 12.0 * (30.0 / self.radius.clamp(21.0, 84.0)).sqrt();
        let recoil = (self.elastic_recoil * 2.0).min(1.0);
        let (stiffness, damping, pressure_decay, limit) = if mounted {
            (115.0, 16.0, 0.92, MAX_STRAIN)
        } else {
            (108.0, 13.0, 0.965, self.strain_limit())
        };
        let tension = stiffness + (frequency.powi(2) - stiffness) * recoil;
        let resistance = damping + (frequency * 0.57 - damping) * recoil;
        self.strain_velocity -= (self.strain - target) * (tension * STEP_SECONDS);
        self.strain_velocity = self.strain_velocity * (1.0 - resistance * STEP_SECONDS);
        self.strain = (self.strain + self.strain_velocity * STEP_SECONDS).limited(limit);
        let pressure_decay = pressure_decay + (0.979 - pressure_decay) * recoil;
        for pressure in &mut self.pressure {
            *pressure *= pressure_decay;
        }
        self.surface_dent.advance(self.radius);
        self.elastic_recoil *= 0.983;
    }

    pub fn integrate(&mut self) {
        let time = STEP_SECONDS;
        let floor_gap = (FLOOR - self.outline.bounds.max.y).max(0.0);
        let wetting = (1.0 - floor_gap / (self.radius * 0.27)).max(0.0);
        let settled = (1.0 - self.velocity.y.abs() / 230.0).max(0.0);
        let floor_shape = Point::X * (0.13 * wetting * settled);
        let speed = self.velocity.length();
        let flow = self.velocity * (1.0 / speed.max(1.0));
        let flow_strength = if flow.y < 0.0 { 0.17 } else { 0.30 };
        let moving_shape =
            flow.double_angle() * (flow_strength * speed / (speed + 420.0) * (1.0 - wetting));
        self.launch_charge *= 1.0 - 0.85 * time;
        self.velocity.y += GRAVITY * time;
        self.velocity = self.velocity.limited(MAX_SPEED) * (1.0 - self.drag * time);
        self.position += self.velocity * time;
        self.recover_shape(floor_shape + moving_shape, false);
        self.impact *= 0.94;
        self.rail_load = [0.0; 2];
        self.update_outline();
    }

    fn squeeze(&mut self, toward_contact: Point, depth: f32, speed: f32, resting_load: f32) {
        let axis = toward_contact.double_angle();
        let swell = ((speed - 115.0) / 320.0).clamp(0.0, 1.0);
        let broad_swell = swell * ((self.radius - 30.0) / 45.0).clamp(0.0, 1.0);
        self.elastic_recoil = self
            .elastic_recoil
            .max((swell + broad_swell * 0.65).min(1.0));
        let deformation =
            (depth / self.radius * 0.34 + speed * 0.000_045 + swell * 0.035 + broad_swell * 0.038)
                .min(0.125 + swell * 0.025 + broad_swell * 0.013);
        self.strain =
            (self.strain - axis * (deformation * self.softness)).limited(self.strain_limit());
        self.strain_velocity -=
            axis * (speed * (0.0021 + swell * 0.0011 + broad_swell * 0.001) * self.softness);
        self.strain_velocity = self.strain_velocity.limited(3.5 + swell * 0.5);
        let local_load = (resting_load
            + depth / self.radius * 0.47
            + speed * 0.000_24
            + swell * 0.08
            + broad_swell * 0.07)
            .min(0.32 + swell * 0.07)
            * self.softness;
        for (index, contact_load) in self.pressure.iter_mut().enumerate() {
            let direction = self.outline.nodes[index] - self.position;
            let facing = direction.dot(toward_contact) / direction.length();
            let center = ((facing - 0.30) / 0.70).clamp(0.0, 1.0).powi(3);
            let shoulders = facing.max(0.0).powi(3);
            let load = local_load * (center + (shoulders - center) * swell);
            *contact_load += (load - *contact_load).max(0.0) * 0.58;
        }
        self.impact = self.impact.max((speed / 725.0).min(1.0));
        self.update_outline();
    }

    fn strain_limit(&self) -> f32 {
        MAX_STRAIN + (MAX_LAUNCH_STRAIN - MAX_STRAIN) * self.launch_charge
    }

    fn yield_to_launch_pressure(&mut self, normal: Point, depth: f32, approach: f32) -> f32 {
        if self.launch_charge < 0.01 || (depth <= 0.0 && approach <= 0.0) {
            return 0.0;
        }
        let speed = self.velocity.length();
        let forward = self.velocity * speed.max(1.0).recip();
        let alignment = forward.dot(normal);
        let side_load = (1.0 - alignment * alignment).powi(2);
        let momentum = ((speed - SPEED_MIN) / 720.0).clamp(0.0, 1.0);
        // A fast side contact compresses more material across the path. The
        // outline preserves its area, so this expresses as a longer liquid jet.
        let load = (depth.max(0.0) + approach * STEP_SECONDS) / self.radius;
        let compression =
            (load * 2.0 * self.softness).min(0.48) * side_load * momentum * self.launch_charge;
        if compression <= 0.003 {
            return 0.0;
        }
        let strain =
            (self.strain - normal.double_angle() * compression).limited(self.strain_limit());
        let outline = Outline::with_pressure(self.position, self.radius, strain, &self.pressure);
        let retreat = self.outline.interval(normal).1 - outline.interval(normal).1;
        if retreat > 0.0 {
            self.strain = strain;
            self.outline = outline;
        }
        retreat.max(0.0)
    }

    fn retain_launch_momentum(&mut self, before: Point) {
        if self.launch_charge < 0.01 {
            return;
        }
        let prior_motion = before.dot(before).max(1.0);
        let remaining_motion = self.velocity.dot(self.velocity);
        self.launch_charge *= (remaining_motion / prior_motion).sqrt().min(1.0);
    }

    fn wall(
        &mut self,
        normal: Point,
        depth: f32,
        friction: f32,
        restitution: f32,
        resting_load: f32,
    ) -> bool {
        let before = self.velocity;
        let hit_speed = (-before.dot(normal)).max(0.0);
        self.squeeze(normal * -1.0, depth, hit_speed, resting_load);
        let bounce = if hit_speed > 42.0 { restitution } else { 0.0 };
        self.velocity += normal * (hit_speed * (1.0 + bounce));
        let tangent = normal.perpendicular();
        let tangent_speed = self.velocity.dot(tangent);
        let limit = hit_speed * friction;
        self.velocity -= tangent * tangent_speed.clamp(-limit, limit);
        self.retain_launch_momentum(before);
        hit_speed >= TOUCH_SOUND_SPEED
    }

    fn touch_rail(&mut self, side: usize, depth: f32, normal: Point) {
        if depth >= -1.4 {
            let proximity = (1.0 + depth / 1.4).min(1.0);
            let speed = (-self.velocity.dot(normal)).max(0.0);
            let size = self.radius / 65.0;
            let impact = speed / 1350.0 + depth.max(0.0) * 0.093;
            let weight = if self.fragment.is_some() {
                (self.radius / 18.0).min(1.0).powi(2)
            } else {
                1.0
            };
            let load = proximity * size * size * 0.50 + impact * weight;
            self.rail_load[side] = self.rail_load[side].max(load);
        }
    }

    pub fn advance_mount(&mut self, home: Point) {
        let dt = STEP_SECONDS;
        self.velocity -= ((self.position - home) * 190.0 + self.velocity * 17.0) * dt;
        self.velocity = self.velocity.limited(390.0);
        self.position += self.velocity * dt;
        self.recover_shape(Point::default(), true);
        self.update_outline();
        self.limit_mount_travel(home);
    }

    pub fn limit_mount_travel(&mut self, home: Point) {
        let offset = self.position - home;
        let travel = (self.radius * 0.57 + 4.0).min(24.0);
        let limited = offset.limited(travel);
        if offset.length() > travel {
            let outward = limited * travel.recip();
            self.velocity -= outward * self.velocity.dot(outward).max(0.0);
            self.move_by(limited - offset);
        }
    }

    pub fn bump_rack(&mut self, held: &mut Self, contact: Contact) -> bool {
        let normal = contact.normal;
        let prior_velocity = self.velocity;
        let relative = self.velocity - held.velocity;
        let approach = relative.dot(normal).max(0.0);
        let demand = approach.max(self.velocity.dot(normal));
        let yield_amount = ((demand - 24.0) / 230.0).clamp(0.0, 1.0);
        // A swift hit moves the suspended liquid. The spring carries its load
        // gradually, so a settled body still has a reliable support below it.
        let effective_mass = held.mass * (3.4 - 3.18 * yield_amount);
        let shot_share = effective_mass / (self.mass + effective_mass);
        let held_share = 1.0 - shot_share;
        let tangent = normal.perpendicular();
        let depth = contact.depth.max(0.0);
        let retreat = self.yield_to_launch_pressure(normal, depth, approach);
        let reaction = normal_reaction(approach, retreat);
        let friction = relative
            .dot(tangent)
            .clamp(-0.018 * reaction, 0.018 * reaction);
        let impact = normal * reaction + tangent * friction;
        self.velocity -= impact * shot_share;
        held.velocity += impact * held_share;
        self.retain_launch_momentum(prior_velocity);
        if depth > 0.0 || approach > 0.0 {
            self.squeeze(
                normal,
                depth * 0.42,
                material_impact(reaction, shot_share) * 0.57,
                0.055,
            );
            held.squeeze(
                normal * -1.0,
                depth * 0.92,
                material_impact(reaction, held_share),
                0.055,
            );
            let overlap =
                (self.outline.interval(normal).1 - held.outline.interval(normal).0).max(0.0);
            let movement = normal * overlap * 0.97;
            self.move_by(movement * -shot_share);
            held.move_by(movement * held_share);
        }
        approach >= TOUCH_SOUND_SPEED
    }

    pub fn contain(&mut self, left: f32, right: f32) -> bool {
        let mut collided = false;
        let left_depth = left - self.outline.bounds.min.x;
        self.touch_rail(0, left_depth, Point::X);
        if left_depth > 0.0 {
            collided |= self.wall(Point::X, left_depth, 0.035, 0.045, 0.09);
            self.move_by(Point::X * (left - self.outline.bounds.min.x).max(0.0));
        }
        let rightward = Point::X * -1.0;
        let right_depth = self.outline.bounds.max.x - right;
        self.touch_rail(1, right_depth, rightward);
        if right_depth > 0.0 {
            collided |= self.wall(rightward, right_depth, 0.035, 0.045, 0.09);
            self.move_by(rightward * (self.outline.bounds.max.x - right).max(0.0));
        }
        let top_depth = TOP - self.outline.bounds.min.y;
        if top_depth > 0.0 {
            collided |= self.wall(Point::Y, top_depth, 0.025, 0.58, 0.03);
            // Keep the dented surface on the rail at the instant of rebound.
            self.move_by(Point::Y * (TOP - self.outline.bounds.min.y));
        }
        let up = Point::Y * -1.0;
        let bottom_depth = self.outline.bounds.max.y - FLOOR;
        if bottom_depth > 0.0 {
            collided |= self.wall(up, bottom_depth, 0.078, 0.022, 0.16);
            self.move_by(up * (self.outline.bounds.max.y - FLOOR));
        }
        self.project_inside(left, right);
        collided
    }

    pub fn project_inside(&mut self, left: f32, right: f32) {
        // Compression on one axis can widen the perpendicular axis at a corner.
        let offset = Point::new(
            (left - self.outline.bounds.min.x).max(0.0)
                - (self.outline.bounds.max.x - right).max(0.0),
            (TOP - self.outline.bounds.min.y).max(0.0)
                - (self.outline.bounds.max.y - FLOOR).max(0.0),
        );
        self.move_by(offset);
    }
}

fn normal_reaction(approach: f32, retreat: f32) -> f32 {
    // The retreat absorbs part of the normal travel during a tick. The rest
    // remains a reciprocal collision impulse on the two moving bodies.
    approach - (retreat / STEP_SECONDS).min(approach * 0.78)
}

fn material_impact(reaction: f32, weight: f32) -> f32 {
    // The impact spreads through the shoulders even when a heavy droplet
    // receives little whole-body motion. Slow sustained contacts remain gentle.
    reaction * weight + (reaction - 160.0).max(0.0) * (weight.sqrt() - weight) * 1.15
}

pub fn resolve(a: &mut Ball, b: &mut Ball, contact: Contact) -> bool {
    let normal = contact.normal;
    let relative = b.velocity - a.velocity;
    let approach = (-relative.dot(normal)).max(0.0);
    let total = a.mass + b.mass;
    let weight_a = b.mass / total;
    let weight_b = a.mass / total;
    let prior_velocities = [a.velocity, b.velocity];
    let depth = contact.depth.max(0.0);
    let retreat_a = a.yield_to_launch_pressure(normal, depth, approach);
    let retreat_b = b.yield_to_launch_pressure(normal * -1.0, depth, approach);
    let reaction = normal_reaction(approach, retreat_a + retreat_b);
    let rebound = if approach > 55.0 { 1.02 } else { 1.0 };
    let tangent = normal.perpendicular();
    let friction = relative
        .dot(tangent)
        .clamp(-0.032 * reaction, 0.032 * reaction);
    let impulse = normal * (reaction * rebound) - tangent * friction;
    a.velocity -= impulse * weight_a;
    b.velocity += impulse * weight_b;
    a.retain_launch_momentum(prior_velocities[0]);
    b.retain_launch_momentum(prior_velocities[1]);

    if depth > 0.0 || approach > 0.0 {
        let first_speed = prior_velocities[0].dot(normal).max(0.0);
        let second_speed = (-prior_velocities[1].dot(normal)).max(0.0);
        let closing_speed = (first_speed + second_speed).max(1.0);
        a.record_surface_impact(b, normal, reaction, second_speed / closing_speed);
        b.record_surface_impact(a, normal * -1.0, reaction, first_speed / closing_speed);
        a.squeeze(
            normal,
            depth * weight_a,
            material_impact(reaction, weight_a),
            0.09,
        );
        b.squeeze(
            normal * -1.0,
            depth * weight_b,
            material_impact(reaction, weight_b),
            0.09,
        );
        // Re-evaluate the overlap along this normal after the surfaces deform.
        // A dented contact should not be pushed apart a second time.
        let overlap = (a.outline.interval(normal).1 - b.outline.interval(normal).0).max(0.0);
        let correction = normal * (overlap * 0.9);
        a.move_by(correction * -weight_a);
        b.move_by(correction * weight_b);
    }
    approach >= TOUCH_SOUND_SPEED
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::contact;

    #[test]
    fn floor_impact_opens_a_wet_footprint_without_bouncing() {
        let mut drop = Ball::new(
            BallId::new(1, 1),
            Point::new(320.0, FLOOR - 80.0),
            Point::new(0.0, 720.0),
        );
        let mut fastest_recoil: f32 = 0.0;
        for _ in 0..260 {
            drop.integrate();
            drop.contain(LEFT, RIGHT);
            fastest_recoil = fastest_recoil.min(drop.velocity.y);
        }
        assert!(fastest_recoil > -25.0, "vertical recoil {fastest_recoil}");

        let base = drop.outline.bounds.max.y;
        assert!((base - FLOOR).abs() < 0.05);
        let support = drop
            .outline
            .nodes
            .iter()
            .filter(|point| point.y > base - 2.2);
        let (left, right) = support.fold(
            (f32::INFINITY, f32::NEG_INFINITY),
            |(left, right), point| (left.min(point.x), right.max(point.x)),
        );
        assert!(right - left > 16.0, "footprint {}", right - left);

        let area = drop
            .outline
            .nodes
            .iter()
            .zip(drop.outline.nodes.iter().cycle().skip(1))
            .map(|(a, b)| {
                let a = *a - drop.position;
                let b = *b - drop.position;
                a.x * b.y - a.y * b.x
            })
            .sum::<f32>()
            * 0.5;
        assert!((area - 3.0 * radius(1).powi(2)).abs() < 0.02);
    }

    #[test]
    fn grazing_liquids_keep_their_slide_after_a_normal_impulse() {
        let mut incoming = Ball::new(
            BallId::new(1, 1),
            Point::new(260.0, 410.0),
            Point::new(520.0, 390.0),
        );
        let mut support = Ball::new(
            BallId::new(2, 3),
            Point::new(316.0, 410.0),
            Point::default(),
        );
        let collision = contact(&incoming.outline, &support.outline).unwrap();
        let tangent = collision.normal.perpendicular();
        let before = incoming.velocity - support.velocity;
        resolve(&mut incoming, &mut support, collision);
        let after = incoming.velocity - support.velocity;
        assert!(after.dot(tangent).abs() > before.dot(tangent).abs() * 0.90);
        assert!(after.dot(collision.normal).abs() < before.dot(collision.normal).abs() * 0.03);
        assert!(incoming.pressure.iter().any(|&load| load > 0.08));
    }

    #[test]
    fn a_heavy_drop_spreads_and_recoils_after_a_sharp_slide() {
        let mut incoming = Ball::new(
            BallId::new(1, 1),
            Point::new(304.0, 302.0),
            Point::new(-240.0, 1000.0),
        );
        let mut support = Ball::new(
            BallId::new(2, 7),
            Point::new(320.0, 394.0),
            Point::default(),
        );
        let collision = contact(&incoming.outline, &support.outline).unwrap();
        let normal = collision.normal;
        let tangent = normal.perpendicular();
        let (rest_min, rest_max) = support.outline.interval(tangent);
        let rest_width = rest_max - rest_min;
        let slide = (incoming.velocity - support.velocity).dot(tangent);
        resolve(&mut incoming, &mut support, collision);
        assert!(support.velocity.dot(normal) > 70.0);
        assert!((incoming.velocity - support.velocity).dot(tangent).abs() > slide.abs() * 0.9);

        let mut squeezed = 0.0_f32;
        let mut recovered = 0.0_f32;
        for step in 0..110 {
            // The drops have slid apart. Follow the shape without additional impacts or drift.
            support.velocity = Point::default();
            support.integrate();
            let shape = support.strain.dot(normal.double_angle());
            squeezed = squeezed.min(shape);
            recovered = recovered.max(shape);
            if step == 19 {
                let (min, max) = support.outline.interval(tangent);
                assert!(max - min > rest_width * 1.075, "width {}", max - min);
                assert!(support.pressure.iter().any(|&load| load > 0.05));
            }
        }
        assert!(squeezed < -0.065, "peak compression {squeezed}");
        assert!(recovered > 0.013, "return past equilibrium {recovered}");
        assert!(recovered < -squeezed * 0.4);
        assert!(support.strain.length() < 0.03);
    }

    #[test]
    fn a_centered_downward_hit_leaves_a_deep_dent_that_recovers_gradually() {
        let mut support = Ball::new(
            BallId::new(2, 7),
            Point::new(320.0, FLOOR - radius(7)),
            Point::default(),
        );
        let mut incoming = Ball::new(
            BallId::new(1, 1),
            support.position - Point::Y * (radius(7) + radius(1) - 1.0),
            Point::Y * 970.0,
        );
        let collision = contact(&incoming.outline, &support.outline).unwrap();
        resolve(&mut incoming, &mut support, collision);

        let [x, y, initial_depth, width] = support.surface_impact();
        assert!(x.abs() < 0.08 && y < -0.99, "surface normal ({x}, {y})");
        assert!(initial_depth > 6.0 && width > 30.0);
        assert!(support.velocity.y > 70.0, "real momentum transfer");

        let mut depths = Vec::new();
        for _ in 0..120 {
            support.velocity = Point::default();
            support.integrate();
            support.contain(LEFT, RIGHT);
            depths.push(support.surface_impact()[2]);
        }
        let maximum_depth = depths.iter().copied().fold(0.0_f32, f32::max);
        assert!(maximum_depth > 17.0, "peak dent {maximum_depth}");
        assert!(
            depths[26] > maximum_depth * 0.65,
            "dent at 225ms: {}",
            depths[26]
        );
        assert!(
            depths[47].abs() < maximum_depth * 0.4,
            "dent at 400ms: {}",
            depths[47]
        );
        assert!(
            depths.iter().any(|&depth| depth < -0.6),
            "overshoot on return"
        );
        assert!(depths[119].abs() < 0.8, "dent at 1s: {}", depths[119]);
    }

    #[test]
    fn upward_graze_squeezes_and_slides_past_a_held_drop() {
        let mut drop = Ball::new(
            BallId::new(1, 2),
            Point::new(320.0, 124.0),
            Point::default(),
        );
        let mut held = Ball::new(
            BallId::new(2, 1),
            Point::new(371.0, 124.0),
            Point::default(),
        );
        let collision = contact(&drop.outline, &held.outline).unwrap();
        let tangent = collision.normal.perpendicular();
        drop.velocity = collision.normal * 370.0 - tangent * 750.0;

        assert!(drop.bump_rack(&mut held, collision));

        assert!(drop.velocity.dot(tangent) < -735.0);
        assert!(drop.velocity.y < -600.0);
        assert!((drop.velocity - held.velocity).dot(collision.normal).abs() < 10.0);
        assert!(held.velocity.dot(collision.normal) > 250.0);
        assert!(held.pressure.iter().any(|&load| load > 0.08));
        assert!(contact(&drop.outline, &held.outline).is_none_or(|touch| touch.depth < 0.2));
    }

    #[test]
    fn charge_controls_whether_a_launch_squeezes_between_two_drops() {
        let opening = 20.0;
        let center = Point::new(320.0, 385.0);
        let support_positions = [
            center - Point::X * (radius(7) + opening * 0.5),
            center + Point::X * (radius(8) + opening * 0.5),
        ];
        let run = |power| {
            let mut drop = Ball::new(
                BallId::new(3, 1),
                center - Point::Y * 142.0,
                Point::Y * launch_speed(power),
            );
            drop.launch_stretch();
            drop.set_launch_power(power);
            let mut crossed_within_clearance = false;
            let mut transferred_pressure = [false; 2];
            let mut furthest: f32 = 0.0;
            let mut first_touch = None;
            for step in 0..100 {
                drop.integrate();
                // The surrounding pile braces both supports each step.
                let mut supports = [
                    Ball::new(BallId::new(1, 7), support_positions[0], Point::default()),
                    Ball::new(BallId::new(2, 8), support_positions[1], Point::default()),
                ];
                for _ in 0..4 {
                    for support in &mut supports {
                        if let Some(collision) = contact(&drop.outline, &support.outline) {
                            first_touch.get_or_insert(step);
                            resolve(&mut drop, support, collision);
                        }
                    }
                }
                for (support, pressed) in supports.iter().zip(&mut transferred_pressure) {
                    *pressed |= support.velocity.length() > 4.0
                        && support.pressure.iter().any(|&load| load > 0.015);
                }
                let bounds = drop.outline.bounds;
                if (drop.position.y - center.y).abs() < 8.0 {
                    crossed_within_clearance |= bounds.min.x > center.x - opening * 0.5 - 1.0
                        && bounds.max.x < center.x + opening * 0.5 + 1.0;
                }
                furthest = furthest.max(drop.position.y);
                if first_touch.is_some_and(|touch| step - touch >= 18) {
                    break;
                }
            }
            (furthest, crossed_within_clearance, transferred_pressure)
        };
        let (weak_depth, _, _) = run(0.15);
        let (charged_depth, squeezed_through, pushed_supports) = run(1.0);
        assert!(weak_depth < center.y, "weak shot reached {weak_depth}");
        assert!(
            charged_depth > center.y + 45.0,
            "charged shot reached {charged_depth}"
        );
        assert!(squeezed_through);
        assert_eq!(pushed_supports, [true; 2]);
    }
}
