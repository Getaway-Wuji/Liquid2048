use std::ops::{Add, AddAssign, Mul, Sub, SubAssign};

pub const NODE_COUNT: usize = 12;
const CONTACT_MARGIN: f32 = 0.38;
const DIRECTIONS: [Point; NODE_COUNT] = [
    Point::new(1.0, 0.0),
    Point::new(0.866_025_4, 0.5),
    Point::new(0.5, 0.866_025_4),
    Point::new(0.0, 1.0),
    Point::new(-0.5, 0.866_025_4),
    Point::new(-0.866_025_4, 0.5),
    Point::new(-1.0, 0.0),
    Point::new(-0.866_025_4, -0.5),
    Point::new(-0.5, -0.866_025_4),
    Point::new(0.0, -1.0),
    Point::new(0.5, -0.866_025_4),
    Point::new(0.866_025_4, -0.5),
];

#[derive(Clone, Copy, Debug, Default)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

impl Point {
    pub const X: Self = Self::new(1.0, 0.0);
    pub const Y: Self = Self::new(0.0, 1.0);

    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    pub fn dot(self, other: Self) -> f32 {
        self.x * other.x + self.y * other.y
    }

    pub fn length(self) -> f32 {
        self.dot(self).sqrt()
    }

    pub fn limited(self, max: f32) -> Self {
        let length_squared = self.dot(self);
        if length_squared > max * max {
            return self * (max / length_squared.sqrt());
        }
        self
    }

    pub const fn perpendicular(self) -> Self {
        Self::new(-self.y, self.x)
    }

    pub const fn double_angle(self) -> Self {
        Self::new(self.x * self.x - self.y * self.y, 2.0 * self.x * self.y)
    }
}

impl Add for Point {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Self::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl Sub for Point {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self {
        Self::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl Mul<f32> for Point {
    type Output = Self;

    fn mul(self, rhs: f32) -> Self {
        Self::new(self.x * rhs, self.y * rhs)
    }
}

impl AddAssign for Point {
    fn add_assign(&mut self, rhs: Self) {
        *self = *self + rhs;
    }
}

impl SubAssign for Point {
    fn sub_assign(&mut self, rhs: Self) {
        *self = *self - rhs;
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub min: Point,
    pub max: Point,
}

impl Bounds {
    pub fn intersects(self, other: Self) -> bool {
        self.min.x <= other.max.x + CONTACT_MARGIN
            && self.max.x >= other.min.x - CONTACT_MARGIN
            && self.min.y <= other.max.y + CONTACT_MARGIN
            && self.max.y >= other.min.y - CONTACT_MARGIN
    }

    pub fn entirely_right_of(self, other: Self) -> bool {
        self.min.x > other.max.x + CONTACT_MARGIN
    }
}

#[derive(Clone)]
pub struct Outline {
    pub bounds: Bounds,
    pub nodes: [Point; NODE_COUNT],
    pub angle: f32,
    pub radius_x: f32,
    pub radius_y: f32,
    symmetric: bool,
}

impl Outline {
    pub fn new(center: Point, radius: f32, strain: Point) -> Self {
        Self::with_pressure(center, radius, strain, &[0.0; NODE_COUNT])
    }

    pub fn with_pressure(
        center: Point,
        radius: f32,
        strain: Point,
        pressure: &[f32; NODE_COUNT],
    ) -> Self {
        let length = strain.length();
        let axis = if length > 0.000_001 {
            strain * length.recip()
        } else {
            Point::X
        };
        let stretch = length.exp();
        let average = radius * (stretch + stretch.recip()) * 0.5;
        let deviance = radius * (stretch - stretch.recip()) * 0.5;
        // The symmetric transform has determinant radius², preserving each polygon's area.
        // The double-angle coordinates let its eigendirections rotate without a wrap discontinuity.
        let xx = average + deviance * axis.x;
        let xy = deviance * axis.y;
        let yy = average - deviance * axis.x;
        let rest = DIRECTIONS.map(|direction| {
            Point::new(
                xx * direction.x + xy * direction.y,
                xy * direction.x + yy * direction.y,
            )
        });
        let mut local = rest;
        let mut symmetric = true;
        if pressure.iter().any(|&load| load > 0.001) {
            // Convex contact stays conservative. If several contacts dent neighboring
            // portions too sharply, keep the pressure but spread its visible response.
            let mut response = 1.0;
            for _ in 0..4 {
                let dented = std::array::from_fn(|i| rest[i] * (1.0 - response * pressure[i]));
                if is_convex(&dented) {
                    // Filling the untouched shoulders keeps the material area stable.
                    let scale = (6.0 * radius * radius / twice_area(&dented)).sqrt();
                    local = dented.map(|node| node * scale);
                    symmetric = false;
                    break;
                }
                response *= 0.62;
            }
        }
        let mut bounds = Bounds {
            min: center,
            max: center,
        };
        let nodes = local.map(|point| {
            let point = center + point;
            bounds.min.x = bounds.min.x.min(point.x);
            bounds.min.y = bounds.min.y.min(point.y);
            bounds.max.x = bounds.max.x.max(point.x);
            bounds.max.y = bounds.max.y.max(point.y);
            point
        });
        Self {
            bounds,
            nodes,
            angle: 0.5 * axis.y.atan2(axis.x),
            radius_x: radius * stretch,
            radius_y: radius * stretch.recip(),
            symmetric,
        }
    }

    pub fn translate(&mut self, offset: Point) {
        self.bounds.min += offset;
        self.bounds.max += offset;
        for point in &mut self.nodes {
            *point += offset;
        }
    }

    pub fn interval(&self, axis: Point) -> (f32, f32) {
        if !self.symmetric {
            let first = self.nodes[0].dot(axis);
            return self.nodes[1..]
                .iter()
                .fold((first, first), |(min, max), point| {
                    let distance = point.dot(axis);
                    (min.min(distance), max.max(distance))
                });
        }
        // An undented outline still has diametrically opposite node pairs.
        let mut max = f32::NEG_INFINITY;
        let center = (self.nodes[0] + self.nodes[6]) * 0.5;
        let center_along = center.dot(axis);
        for point in &self.nodes[..NODE_COUNT / 2] {
            let distance = point.dot(axis) - center_along;
            max = max.max(distance.abs());
        }
        (center_along - max, center_along + max)
    }
}

fn cross(a: Point, b: Point) -> f32 {
    a.x * b.y - a.y * b.x
}

fn twice_area(nodes: &[Point; NODE_COUNT]) -> f32 {
    (0..NODE_COUNT)
        .map(|i| cross(nodes[i], nodes[(i + 1) % NODE_COUNT]))
        .sum()
}

fn is_convex(nodes: &[Point; NODE_COUNT]) -> bool {
    (0..NODE_COUNT).all(|i| {
        let a = nodes[i];
        let b = nodes[(i + 1) % NODE_COUNT];
        let c = nodes[(i + 2) % NODE_COUNT];
        cross(b - a, c - b) >= 0.0
    })
}

#[derive(Clone, Copy)]
pub struct Contact {
    /// Direction from the first outline to the second.
    pub normal: Point,
    pub depth: f32,
}

pub fn contact(a: &Outline, b: &Outline) -> Option<Contact> {
    if !a.bounds.intersects(b.bounds) {
        return None;
    }
    let mut best = Contact {
        normal: Point::X,
        depth: f32::INFINITY,
    };
    for source in [a, b] {
        let edge_count = if source.symmetric {
            NODE_COUNT / 2
        } else {
            NODE_COUNT
        };
        for index in 0..edge_count {
            let edge = source.nodes[(index + 1) % NODE_COUNT] - source.nodes[index];
            let axis = edge.perpendicular() * edge.length().recip();
            let (min_a, max_a) = a.interval(axis);
            let (min_b, max_b) = b.interval(axis);
            let forward = max_a - min_b;
            let backward = max_b - min_a;
            let depth = forward.min(backward);
            if depth < -CONTACT_MARGIN {
                return None;
            }
            if depth < best.depth {
                let normal = if forward <= backward {
                    axis
                } else {
                    axis * -1.0
                };
                best = Contact { normal, depth };
            }
        }
    }
    Some(best)
}
