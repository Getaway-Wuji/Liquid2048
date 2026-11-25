use super::*;
use crate::physics::{GRAVITY, TOP};

fn test_ball(game: &mut Game, level: u32, x: f32, y: f32, dx: f32, dy: f32) {
    let identity = game.identity(level);
    game.balls
        .push(Ball::new(identity, Point::new(x, y), Point::new(dx, dy)));
}

fn advance(game: &mut Game, steps: u32) {
    for _ in 0..steps {
        game.advance();
    }
}

fn test_shard(game: &mut Game, owner: BallId, position: Point, area: f32) -> BallId {
    let identity = game.body_id(0);
    let mut shard = Ball::new(identity, position, Point::default());
    shard.set_area(area);
    shard.fragment = Some(crate::splash::Fragment::new(owner, 0));
    game.balls.push(shard);
    identity
}

#[test]
fn a_stranded_shard_transfers_area_on_contact_without_changing_number_or_score() {
    let mut game = Game::new(11);
    test_ball(&mut game, 3, 160.0, 420.0, 0.0, 0.0);
    test_ball(&mut game, 1, 360.0, 420.0, 0.0, 0.0);
    let owner = game.balls[0].identity;
    let neighbor = game.balls[1].identity;
    let shard_area = 64.0;
    let owner_area = game.balls[0].area() - shard_area;
    let neighbor_area = game.balls[1].area();
    game.balls[0].set_area(owner_area);
    let shard = test_shard(&mut game, owner, Point::new(408.0, 420.0), shard_area);
    game.tick = 1_000;

    game.advance();
    assert_eq!(game.balls[2].identity, shard);
    assert_eq!(game.balls[1].area(), neighbor_area);

    let contact_at = game.balls[1].position + Point::X * 31.0;
    let to_contact = contact_at - game.balls[2].position;
    game.balls[2].move_by(to_contact);
    game.balls[1].velocity.x = 20.0;
    game.balls[2].velocity.x = -30.0;
    let horizontal_momentum = game.balls[1].mass * game.balls[1].velocity.x
        + game.balls[2].mass * game.balls[2].velocity.x;
    game.advance();

    assert_eq!(game.balls.len(), 2);
    assert_eq!(game.balls[0].identity, owner);
    assert_eq!(game.balls[1].identity, neighbor);
    assert!((game.balls[0].area() - owner_area).abs() < 0.005);
    assert!((game.balls[1].area() - neighbor_area - shard_area).abs() < 0.005);
    assert!((game.balls[1].mass * game.balls[1].velocity.x - horizontal_momentum).abs() < 0.15);
    assert_eq!(game.merges, 0);
    assert_eq!(game.scored_merges, 0);
    assert_eq!(game.score_text, "0");

    assert_eq!(game.splash(owner.id, game.balls[0].position), 1);
    assert!(game.balls.iter().any(|ball| ball.fragment.is_some()));
}

#[test]
fn a_stranded_shard_cannot_block_another_splash_or_numeric_split() {
    let mut game = Game::new(11);
    test_ball(&mut game, 2, 300.0, 420.0, 0.0, 0.0);
    let owner = game.balls[0].identity;
    let initial_area = game.balls[0].area();
    let shard_area = 64.0;
    game.balls[0].set_area(initial_area - shard_area);
    let old_piece = test_shard(&mut game, owner, Point::new(510.0, 420.0), shard_area);
    game.tick = 1_000;

    assert_eq!(game.splash(owner.id, Point::new(308.0, 420.0)), 1);
    assert!(game.balls.iter().any(|ball| ball.identity == old_piece));
    assert!(game.balls.iter().any(|ball| {
        ball.identity != old_piece && ball.fragment.is_some_and(|piece| piece.owner == owner)
    }));
    assert_eq!(game.splash(owner.id, Point::new(308.0, 420.0)), 1);
    assert_eq!(game.splash(owner.id, Point::new(308.0, 420.0)), 2);
    assert_eq!(
        game.balls
            .iter()
            .filter(|ball| ball.fragment.is_none())
            .map(|ball| ball.identity.level)
            .collect::<Vec<_>>(),
        [1, 1],
    );
    assert!((game.balls.iter().map(Ball::area).sum::<f32>() - initial_area).abs() < 0.005);
    assert_eq!(game.score_text, "0");
}

#[test]
fn touching_equal_balls_merge_once() {
    let mut game = Game::new(9);
    test_ball(&mut game, 1, 300.0, 500.0, 0.0, 0.0);
    test_ball(&mut game, 1, 347.0, 500.0, 0.0, 0.0);
    advance(&mut game, 20);
    assert_eq!(game.merges, 1);
    assert_eq!(game.balls.len(), 1);
    assert_eq!(game.balls[0].identity.level, 2);
    assert_eq!(game.score_text, "4");
    assert_eq!(game.scored_merges, 1);
    assert_eq!(game.merge_events[0][0], 1.0);
    assert_eq!(game.merge_events[0][4], -1.0);
}

#[test]
fn split_numbers_merge_on_renewed_contact_without_scoring_again() {
    let mut game = Game::new(11);
    test_ball(&mut game, 2, 300.0, 500.0, -90.0, 0.0);
    let owner = game.balls[0].identity;
    let initial_area = game.balls[0].area();
    let half_area = initial_area * 0.5;
    game.balls[0].set_area(half_area);
    game.balls[0].identity.level = 1;

    let mut half = Ball::new(
        BallId {
            id: game.body_id(1).id,
            ..game.balls[0].identity
        },
        Point::new(326.0, 500.0),
        Point::new(90.0, 0.0),
    );
    half.set_area(half_area);
    half.separating_from = Some(owner.id);
    game.balls.push(half);
    let initial_contact = contact(&game.balls[0].outline, &game.balls[1].outline).unwrap();
    assert!(initial_contact.depth > 0.0);

    game.advance();
    assert_eq!(game.balls.len(), 2, "the split initially shares a boundary");
    advance(&mut game, 8);
    assert!(contact(&game.balls[0].outline, &game.balls[1].outline).is_none());
    assert!(game.balls[1].separating_from.is_none());

    game.balls[0].velocity.x = 150.0;
    game.balls[1].velocity.x = -150.0;
    advance(&mut game, 20);
    assert_eq!(game.balls.len(), 1);
    assert_eq!(game.balls[0].identity.level, 2);
    assert!((game.balls[0].area() - initial_area).abs() < 0.005);
    assert_eq!(game.merges, 1);
    assert_eq!(game.merge_events[0][0], 1.0);
    assert_eq!(game.score_text, "0");
    assert_eq!(game.scored_merges, 0);
    assert_eq!(game.achievement_flags(0), 0);
}

#[test]
fn split_numbers_remain_separate_inside_the_contact_margin() {
    let mut game = Game::new(11);
    test_ball(&mut game, 2, 300.0, 500.0, 0.0, 0.0);
    let half_area = game.balls[0].area() * 0.5;
    game.balls[0].set_area(half_area);
    let owner = game.balls[0].identity;
    game.balls[0].identity.level = 1;
    let mut other = Ball::new(
        BallId {
            id: game.body_id(1).id,
            ..game.balls[0].identity
        },
        Point::new(300.0 + 2.0 * half_area.sqrt() + 0.2, 500.0),
        Point::default(),
    );
    other.set_area(half_area);
    other.separating_from = Some(owner.id);
    game.balls.push(other);

    game.advance();
    assert_eq!(game.balls.len(), 2);
    assert!(game.balls[1].separating_from.is_none());
    let near_contact = contact(&game.balls[0].outline, &game.balls[1].outline).unwrap();
    assert!(near_contact.depth < 0.0);

    game.balls[1].velocity.x = -48.0;
    game.advance();
    assert_eq!(game.balls.len(), 1);
}

#[test]
fn mixed_partners_score_only_new_material_and_keep_the_inherited_ceiling() {
    let mut game = Game::new(11);
    let position = Point::default();
    let [cross_a, cross_b, mixed_a, mixed_b] = std::array::from_fn(|_| BallId {
        score_ceiling: 4,
        ..game.identity(2)
    });
    let cross_pair = game.merge(cross_a, cross_b, position, None);
    assert_eq!((cross_pair.level, cross_pair.score_ceiling), (3, 4));
    assert_eq!(game.score_text, "0");

    let new_four = game.identity(2);
    let mixed = game.merge(mixed_a, new_four, position, None);
    assert_eq!((mixed.level, mixed.score_ceiling), (3, 4));
    assert_eq!(game.score_text, "4");

    let split_again = BallId { level: 2, ..mixed };
    let reassembled = game.merge(split_again, mixed_b, position, None);
    assert_eq!((reassembled.level, reassembled.score_ceiling), (3, 4));
    let restored = game.merge(reassembled, cross_pair, position, None);
    assert_eq!((restored.level, restored.score_ceiling), (4, 4));
    assert_eq!(game.score_text, "4");
    assert_eq!(game.scored_merges, 1);

    let matching_sixteen = game.identity(4);
    let higher = game.merge(restored, matching_sixteen, position, None);
    assert_eq!((higher.level, higher.score_ceiling), (5, 5));
    assert_eq!(game.score_text, "36");
    assert_eq!(game.scored_merges, 2);
    assert_eq!(game.merges, 5);
}

#[test]
fn rack_merge_carries_the_scoring_ceiling_through_launch() {
    let mut game = Game::new(11);
    let held = BallId {
        score_ceiling: 4,
        ..game.identity(2)
    };
    game.slots[0] = Some(held);
    let center = game.rack_centers()[0];
    test_ball(&mut game, 2, center.x, center.y + 40.0, 0.0, -40.0);
    game.balls[0].identity.score_ceiling = 4;
    game.advance();

    let restored = game.slots[0].unwrap();
    assert_eq!((restored.level, restored.score_ceiling), (3, 4));
    assert_eq!(game.score_text, "0");
    assert_eq!(game.scored_merges, 0);
    assert_eq!(game.merges, 1);
    assert_eq!(game.merge_events[0][4], 0.0);
    assert!(game.launch(0, Point::Y, 0.5));
    assert_eq!(game.balls[0].identity, restored);
}

#[test]
fn pool_throw_moves_an_existing_drop_into_a_normal_merge() {
    let mut game = Game::new(11);
    let y = FLOOR - radius(1) - 1.0;
    test_ball(&mut game, 1, 240.0, y, 0.0, 0.0);
    test_ball(&mut game, 1, 333.0, y, 0.0, 0.0);
    let id = game.balls[0].identity.id;

    assert!(game.throw_drop(id, Point::new(1.0, -0.12), 0.72));
    assert_eq!(game.balls.len(), 2);
    assert_eq!(game.balls[0].position.x, 240.0);
    assert_eq!(game.balls[0].area(), radius(1).powi(2));
    assert_eq!(game.score_text, "0");
    assert_eq!(game.shots, 0);

    advance(&mut game, 35);
    assert_eq!(game.balls.len(), 1);
    assert_eq!(game.balls[0].identity.level, 2);
    assert_eq!(game.score_text, "4");
    assert_eq!(game.shots, 0);
}

#[test]
fn pool_throw_bounds_velocity_and_rejects_invalid_targets_and_inputs() {
    let mut game = Game::new(11);
    test_ball(&mut game, 1, 320.0, 380.0, 1000.0, 200.0);
    let parent = game.balls[0].identity;
    let held = game.slots[0].unwrap().id;
    let mut shard = Ball::new(game.body_id(0), Point::new(350.0, 380.0), Point::default());
    shard.fragment = Some(crate::splash::Fragment::new(parent, 0));
    let fragment = shard.identity.id;
    game.balls.push(shard);

    assert!(!game.throw_drop(held, Point::X, 1.0));
    assert!(!game.throw_drop(fragment, Point::X, 1.0));
    assert!(!game.throw_drop(parent.id, Point::default(), 1.0));
    assert!(!game.throw_drop(parent.id, Point::new(f32::NAN, 0.0), 1.0));
    assert!(!game.throw_drop(parent.id, Point::X, 1.1));
    game.paused = true;
    assert!(!game.throw_drop(parent.id, Point::X, 1.0));
    game.paused = false;

    for _ in 0..5 {
        assert!(game.throw_drop(parent.id, Point::X, 1.0));
        assert!(game.balls[0].velocity.length() <= POOL_THROW_MAX_SPEED + 0.001);
    }
    assert!(game.balls[0].velocity.x > 500.0);
    assert_eq!(game.balls[1].velocity.length(), 0.0);
    assert_eq!(game.shots, 0);
    assert_eq!(game.score_text, "0");
}

#[test]
fn different_values_collide_and_deform_without_merging() {
    let mut game = Game::new(9);
    test_ball(&mut game, 1, 290.0, 400.0, 530.0, -GRAVITY * STEP_SECONDS);
    test_ball(&mut game, 3, 353.0, 400.0, 0.0, -GRAVITY * STEP_SECONDS);
    advance(&mut game, 2);
    let small = &game.balls[0];
    let big = &game.balls[1];
    assert_eq!(game.merges, 0);
    assert!(small.velocity.x < 300.0);
    assert!(big.velocity.x > 45.0);
    assert!(small.outline.radius_y < radius(1));
    assert!((small.outline.radius_x * small.outline.radius_y - radius(1).powi(2)).abs() < 0.01);
}

#[test]
fn three_balls_cannot_consume_the_same_entity_twice() {
    let mut game = Game::new(9);
    test_ball(&mut game, 1, 300.0, 500.0, 0.0, 0.0);
    test_ball(&mut game, 1, 340.0, 500.0, 0.0, 0.0);
    test_ball(&mut game, 1, 320.0, 530.0, 0.0, 0.0);
    let third = game.balls[2].identity;
    game.advance();
    assert_eq!(game.merges, 1);
    assert_eq!(game.balls.len(), 2);
    assert_eq!(game.balls[0].identity, third);
    assert_eq!(game.balls[1].identity.level, 2);
}

#[test]
fn a_replacement_can_merge_on_the_next_tick() {
    let mut game = Game::new(9);
    test_ball(&mut game, 1, 275.0, 500.0, 0.0, 0.0);
    test_ball(&mut game, 1, 320.0, 500.0, 0.0, 0.0);
    test_ball(&mut game, 2, 359.0, 500.0, 0.0, 0.0);
    game.advance();
    assert_eq!(game.merges, 1);
    game.advance();
    assert_eq!(game.merges, 2);
    assert_eq!(game.balls[0].identity.level, 3);
    assert_eq!(game.score_text, "12");
}

#[test]
fn independent_merges_on_same_tick_have_distinct_events() {
    let mut game = Game::new(9);
    test_ball(&mut game, 1, 120.0, 340.0, 0.0, 0.0);
    test_ball(&mut game, 1, 162.0, 340.0, 0.0, 0.0);
    test_ball(&mut game, 2, 425.0, 380.0, 0.0, 0.0);
    test_ball(&mut game, 2, 480.0, 380.0, 0.0, 0.0);
    game.advance();
    assert_eq!(game.balls.len(), 2);
    assert_eq!(game.merge_events.len(), 2);
    assert_eq!(game.merge_events[0][0], 1.0);
    assert_eq!(game.merge_events[1][0], 2.0);
    assert_eq!(game.score_text, "12");
}

#[test]
fn deformed_outlines_decide_contact_and_preserve_area() {
    let radius = 24.0;
    let a = Outline::new(Point::new(40.0, 80.0), radius, Point::new(-0.32, 0.0));
    let b = Outline::new(Point::new(81.0, 80.0), radius, Point::new(-0.32, 0.0));
    let resting_a = Outline::new(Point::new(40.0, 80.0), radius, Point::default());
    let resting_b = Outline::new(Point::new(81.0, 80.0), radius, Point::default());
    assert!(contact(&a, &b).is_none());
    assert!(contact(&resting_a, &resting_b).is_some());
    let area = |outline: &Outline| {
        outline
            .nodes
            .iter()
            .zip(outline.nodes.iter().cycle().skip(1))
            .map(|(a, b)| a.x * b.y - a.y * b.x)
            .sum::<f32>()
            * 0.5
    };
    assert!((area(&a) - area(&resting_a)).abs() < 0.01);
}

#[test]
fn a_small_ball_can_squeeze_through_a_braced_gap() {
    let mut game = Game::new(9);
    let centers = [Point::new(225.0, 360.0), Point::new(415.0, 360.0)];
    test_ball(&mut game, 7, centers[0].x, centers[0].y, 0.0, 0.0);
    test_ball(&mut game, 7, centers[1].x, centers[1].y, 0.0, 0.0);
    test_ball(&mut game, 1, 320.0, 215.0, 0.0, 550.0);
    let mut squeezed = false;

    for _ in 0..480 {
        // Restore the large supports after each tick to model a braced surrounding pile.
        for (index, center) in centers.into_iter().enumerate() {
            game.balls[index] = Ball::new(game.balls[index].identity, center, Point::default());
        }
        game.advance();
        let small = &game.balls[2];
        let bounds = small.outline.bounds;
        if (bounds.max.x - bounds.min.x) < 42.0 {
            squeezed = true;
        }
        if small.position.y > 420.0 {
            assert!(squeezed);
            return;
        }
    }
    panic!("small ball remained above the gap");
}

#[test]
fn full_rack_launch_squeezes_through_two_tight_gaps() {
    let opening = 18.0;
    let gap_rows = [274.0, 459.0];
    let supports = gap_rows.map(|y| {
        [
            (7, Point::new(RACK_X - radius(7) - opening * 0.5, y)),
            (8, Point::new(RACK_X + radius(8) + opening * 0.5, y)),
        ]
    });
    let supports = supports.as_flattened();
    let run = |power| {
        let mut game = Game::new(9);
        let shot = game.identity(1);
        game.slots[1] = Some(shot);
        for &(level, center) in supports {
            test_ball(&mut game, level, center.x, center.y, 0.0, 0.0);
        }
        game.launch_mask = game.unblocked_entries();
        assert!(game.launch(1, Point::Y, power));

        let mut furthest = RACK_Y;
        let mut displaced_and_deformed = [false; 4];
        let mut narrowest = [f32::INFINITY; 2];
        for _ in 0..60 {
            // Hold the supports in the pile but let their surfaces and motion react each tick.
            for (ball, &(_, center)) in game.balls.iter_mut().zip(supports) {
                *ball = Ball::new(ball.identity, center, Point::default());
            }
            game.advance();
            assert_eq!(game.balls.len(), supports.len() + 1);
            let launched = &game.balls[4];
            furthest = furthest.max(launched.position.y);
            let width = launched.outline.bounds.max.x - launched.outline.bounds.min.x;
            for (row, narrowest) in gap_rows.into_iter().zip(&mut narrowest) {
                if (launched.position.y - row).abs() < 10.0 {
                    *narrowest = narrowest.min(width);
                }
            }
            for ((ball, pressed), &(level, center)) in game
                .balls
                .iter()
                .zip(&mut displaced_and_deformed)
                .zip(supports)
            {
                let outward = Point::X * (center.x - RACK_X).signum();
                let reach = ball.position.dot(outward) - ball.outline.interval(outward).0;
                *pressed |= ball.velocity.dot(outward) > 3.0 && reach < radius(level) - 1.0;
            }
        }
        assert_eq!(game.balls[4].identity, shot);
        assert_eq!(game.balls[4].area(), radius(1).powi(2));
        assert_eq!(game.merges, 0);
        (furthest, narrowest, displaced_and_deformed)
    };

    let (weak_depth, _, _) = run(0.15);
    let (charged_depth, narrowest, displaced_and_deformed) = run(1.0);
    assert!(weak_depth < gap_rows[0], "weak shot reached {weak_depth}");
    assert!(
        charged_depth > gap_rows[1] + 40.0,
        "charged shot reached {charged_depth}"
    );
    assert!(
        narrowest.into_iter().all(|width| width < opening + 9.0),
        "charged shot widths at the gaps were {narrowest:?}"
    );
    assert_eq!(displaced_and_deformed, [true; 4]);
}

#[test]
fn maximum_speed_does_not_pass_through_different_large_ball() {
    let mut game = Game::new(9);
    let shot = game.identity(1);
    game.slots[1] = Some(shot);
    test_ball(&mut game, 7, RACK_X, 415.0, 0.0, 0.0);
    game.launch_mask = game.unblocked_entries();
    assert!(game.launch(1, Point::Y, 1.0));
    for _ in 0..50 {
        game.advance();
        assert_eq!(game.balls.len(), 2);
        assert!(game.balls[1].position.y < game.balls[0].position.y);
    }
    assert!(game.collision_count > 0);
    assert_eq!(game.balls[1].identity, shot);
    assert_eq!(game.merges, 0);
}

#[test]
fn walls_and_floor_contain_maximum_power_shots() {
    for direction in [
        Point::new(-1.0, 0.0),
        Point::new(0.0, 1.0),
        Point::new(1.0, 0.0),
        Point::new(1.0, -1.0),
    ] {
        let mut game = Game::new(9);
        for slot in 0..RACK_SLOTS - 1 {
            game.slots[slot] = Some(game.identity(4));
        }
        game.slots[3] = Some(game.identity(1));
        game.launch_mask = game.unblocked_entries();
        assert!(game.launch(3, direction, 1.0));
        for _ in 0..420 {
            game.advance();
            let (left, right) = game.walls();
            let outline = &game.balls[0].outline.bounds;
            assert!(outline.min.x >= left - 0.002 && outline.max.x <= right + 0.002);
            assert!(outline.min.y >= TOP - 0.002 && outline.max.y <= FLOOR + 0.002);
        }
    }
}

#[test]
fn a_settled_drop_spreads_across_the_floor_without_changing_area() {
    let mut game = Game::new(9);
    test_ball(&mut game, 1, 320.0, FLOOR - 110.0, 0.0, 0.0);
    advance(&mut game, 300);
    let outline = &game.balls[0].outline;
    let aspect = outline.radius_x / outline.radius_y;
    assert!(
        (1.2..=1.55).contains(&aspect),
        "floor footprint ratio {aspect}"
    );
    assert!((outline.bounds.max.y - FLOOR).abs() < 0.05);
    assert!((outline.radius_x * outline.radius_y - radius(1).powi(2)).abs() < 0.01);
}

#[test]
fn right_hand_slot_can_launch_upward_and_the_same_ball_falls() {
    let mut game = Game::new(9);
    let supplied = game.slots[3].unwrap();
    let neighbor_level = if supplied.level == 1 { 2 } else { 1 };
    for slot in 0..RACK_SLOTS - 1 {
        game.slots[slot] = Some(game.identity(neighbor_level));
    }
    game.launch_mask = game.unblocked_entries();
    assert!(game.launch(3, Point::new(0.20, -1.0), 0.72));
    let mut rebound = None;
    for _ in 0..32 {
        let rising = game.balls[0].velocity.y < 0.0;
        game.advance();
        let ball = &game.balls[0];
        if rising && ball.outline.bounds.min.y < TOP + 2.0 && ball.velocity.y > 0.0 {
            rebound = Some(ball.velocity.y);
        }
    }
    assert!(rebound.is_some_and(|speed| speed > 250.0));
    assert!(game.balls[0].position.y < 190.0);
    advance(&mut game, 300);
    assert!(game.balls[0].position.y > 600.0);
    assert_eq!(game.balls[0].identity, supplied);
    assert_eq!(game.shots, 1);
}

#[test]
fn upward_shot_merges_into_a_different_suspended_drop() {
    let mut game = Game::new(1);
    let a = game.slots[0].unwrap();
    let b = game.slots[1].unwrap();
    assert_eq!(a.level, b.level);
    assert!(game.launch(0, Point::new(0.13, -1.0), 0.82));
    assert_eq!(game.slots[0], None);
    assert_eq!(game.merges, 0);
    assert_eq!(game.slots[1], Some(b));
    let mut rebounded = false;
    for _ in 0..32 {
        game.advance();
        rebounded |= game
            .balls
            .first()
            .is_some_and(|ball| ball.velocity.y > 50.0 && ball.outline.bounds.min.y < TOP + 2.0);
    }
    let result = game.slots[1].unwrap();
    assert_eq!(result.level, a.level + 1);
    assert_eq!(game.rack_merge, Some((1, 1)));
    assert!(rebounded);
    assert!(game.slots[0].is_some());
    assert!(game.balls.is_empty());
    assert_eq!(game.merges, 1);
    assert_eq!(game.merge_events[0][4], 1.0);
    assert!(game.launch(1, Point::Y, 0.25));
    assert_eq!(game.balls[0].identity, result);
}

#[test]
fn roof_rebound_reaches_the_opposite_hold_from_either_side() {
    for (origin, matching_hold, direction) in [(0, 2, 0.38), (2, 0, -0.38)] {
        let mut game = Game::new(11);
        let outer = game.slots[origin].unwrap();
        let middle = game.slots[1].unwrap();
        assert_eq!(game.slots[matching_hold].unwrap().level, outer.level);
        assert_ne!(middle.level, outer.level);
        assert!(game.launch(origin, Point::new(direction, -1.0), 0.9));

        let mut rebounded = false;
        for _ in 0..60 {
            let rising = game.balls[0].velocity.y < 0.0;
            game.advance();
            if game.balls.is_empty() {
                break;
            }
            let ball = &game.balls[0];
            rebounded |= rising && ball.velocity.y > 50.0 && ball.outline.bounds.min.y < TOP + 2.0;
        }
        assert!(rebounded);
        assert!(game.balls.is_empty());
        let destination = matching_hold + usize::from(matching_hold < origin);
        let middle_slot = 1 + usize::from(1 < origin);
        assert_eq!(game.slots[middle_slot], Some(middle));
        assert_eq!(game.slots[destination].unwrap().level, outer.level + 1);
        assert_eq!(game.rack_merge, Some((destination, 1)));
        assert_eq!(game.merges, 1);
    }
}

#[test]
fn middle_hold_can_launch_straight_up_and_diagonally_with_both_neighbors() {
    for direction in [-0.5_f32, 0.0, 0.5] {
        let mut game = Game::new(1608);
        let neighbors = [game.slots[0], game.slots[2], game.slots[3]];
        assert!(neighbors.iter().all(Option::is_some));
        let origin = game.rack_centers()[1];
        assert!((game.launch_entries[1] - origin).length() < 0.01);
        assert!(game.launch(1, Point::new(direction, -1.0), 0.9));

        let rebound = (0..48).find_map(|_| {
            let rising = game.balls[0].velocity.y < 0.0;
            game.advance();
            game.balls.first().and_then(|ball| {
                (rising && ball.velocity.y > 200.0 && ball.outline.bounds.min.y < TOP + 10.0)
                    .then_some(ball.position)
            })
        });
        let rebound =
            rebound.unwrap_or_else(|| panic!("center shot at {direction} should reach the roof"));
        let displacement = rebound.x - origin.x;
        if direction == 0.0 {
            assert!(displacement.abs() < 0.1);
        } else {
            assert!(displacement * direction.signum() > 20.0);
        }
        assert_eq!([game.slots[1], game.slots[2], game.slots[3]], neighbors);
    }
}

#[test]
fn a_large_middle_drop_releases_from_its_hold_with_its_area_intact() {
    let mut game = Game::new(1608);
    let large = game.identity(7);
    game.slots[1] = Some(large);
    game.launch_mask = game.unblocked_entries();
    let origin = game.rack_centers()[1];
    assert!((game.launch_entries[1] - origin).length() < 0.01);
    assert!(game.launch(1, Point::new(0.0, -1.0), 0.9));

    let ball = &game.balls[0];
    let bounds = ball.outline.bounds;
    assert!(bounds.max.x - bounds.min.x < bounds.max.y - bounds.min.y);
    assert!(
        (ball.outline.radius_x * ball.outline.radius_y - radius(large.level).powi(2)).abs() < 0.01
    );
    assert!((ball.position - origin).length() < 0.01);
    assert!(ball.outline.bounds.min.y >= TOP);
    for (slot, held) in game.slots.iter().enumerate() {
        if let Some(held) = held {
            assert!(contact(&ball.outline, &game.rack_outline(slot, held.level)).is_none());
        }
    }
    game.advance();
    assert!(game.balls[0].position.y < origin.y);
}

#[test]
fn straight_upward_shot_does_not_merge_with_its_own_replacement() {
    let mut game = Game::new(1);
    assert!(game.launch(0, Point::new(0.0, -1.0), 0.8));
    advance(&mut game, 160);
    assert_eq!(game.merges, 0);
    assert!(game.slots[0].is_some());
    assert_eq!(game.balls.len(), 1);
}

#[test]
fn a_drop_supported_by_adjacent_holds_can_stay_while_their_mouths_remain_available() {
    for left_slot in 0..2 {
        let mut game = Game::new(9);
        let right_slot = left_slot + 1;
        let blocked_pair = 0b011 << left_slot;
        game.slots[left_slot] = Some(game.identity(2));
        game.slots[right_slot] = Some(game.identity(2));
        let centers = game.rack_centers();
        let gap_center = (centers[left_slot].x + centers[right_slot].x) * 0.5;
        test_ball(&mut game, 1, gap_center, 32.0, 0.0, 0.0);

        let mut lower_exit_opened = false;
        for _ in 0..180 {
            game.advance();
            lower_exit_opened |= [left_slot, right_slot].into_iter().any(|slot| {
                game.launch_mask & (1 << slot) != 0
                    && game.launch_entries[slot].y > game.primary_entry(slot).y + 10.0
            });
            assert!(game.balls[0].position.y < RACK_Y);
        }
        assert!(lower_exit_opened);
        assert_eq!(game.merges, 0);
        assert_eq!(game.launch_mask & blocked_pair, blocked_pair);
        assert!(game.launch(left_slot, Point::Y, 0.6));
        for _ in 0..60 {
            if game.launch_mask & (1 << right_slot) != 0 {
                break;
            }
            game.advance();
        }
        assert!(game.launch(right_slot, Point::Y, 0.6));
        for _ in 0..90 {
            if game.slots[left_slot].is_some() && game.slots[right_slot].is_some() {
                break;
            }
            game.advance();
        }
        assert!(game.slots[left_slot].is_some());
        assert!(game.slots[right_slot].is_some());
    }
}

#[test]
fn rack_snapshot_keeps_four_held_drops_close_without_intersections() {
    let game = Game::new(1);
    let radii = game.rack_radii();
    let centers = game.rack_centers();
    for slot in 0..RACK_SLOTS - 1 {
        let next = slot + 1;
        let spacing = centers[next].x - centers[slot].x;
        assert!((spacing - radii[slot] - radii[next] - RACK_GAP).abs() < 0.0001);
        let a = game.rack_outline(slot, game.slots[slot].unwrap().level);
        let b = game.rack_outline(next, game.slots[next].unwrap().level);
        assert!(contact(&a, &b).is_none());
    }
    for (slot, offset) in RACK_CENTER_OFFSETS.into_iter().enumerate() {
        assert_eq!(
            &game.snapshot[offset..offset + 3],
            &[centers[slot].x, RACK_Y, radii[slot]]
        );
        let held = game.slots[slot].unwrap();
        assert_eq!(game.snapshot[RACK_LEVEL_OFFSETS[slot]], held.level as f32);
        assert_eq!(game.snapshot[RACK_ID_OFFSET + slot], held.id as f32);
    }
}

#[test]
fn a_middle_vacancy_is_filled_from_the_left_without_moving_the_far_hold() {
    let mut game = Game::new(11);
    let before = game.slots;
    let homes = game.rack_centers();

    assert!(game.launch(2, Point::Y, 1.0));
    assert_eq!(game.slots[1..], [before[0], before[1], before[3]]);
    let entering = game.slots[0].expect("clear left path should admit another drop");
    assert!(!before.contains(&Some(entering)));
    let targets = game.rack_centers();
    let entrance = game.rack_position(0, targets[0]);
    assert!(entrance.x < targets[0].x - 20.0);
    assert_eq!(game.rack_position(1, targets[1]).x, homes[0].x);
    assert_eq!(game.rack_position(2, targets[2]).x, homes[1].x);
    assert_eq!(targets[3].x, homes[3].x);

    advance(&mut game, 20);
    assert!(game.rack_position(0, targets[0]).x > entrance.x + 10.0);
    assert!(game.rack_position(1, targets[1]).x > homes[0].x + 10.0);
    assert!(game.rack_position(2, targets[2]).x > homes[1].x + 10.0);
    assert_eq!(game.rack_position(3, targets[3]).x, homes[3].x);
    advance(&mut game, 75);
    for (slot, target) in game.rack_centers().into_iter().enumerate() {
        assert!((game.rack_position(slot, target).x - target.x).abs() < 1.0);
    }
}

#[test]
fn blocked_left_supply_resumes_in_order_after_two_quick_shots() {
    let mut game = Game::new(11);
    let before = game.slots;
    let home = game.rack_centers()[0];
    test_ball(&mut game, 5, home.x - 39.0, home.y, 0.0, 0.0);
    let blocker = game.balls[0].identity;
    let rng = game.rng;
    game.launch_mask = game.unblocked_entries();
    assert!(game.launch(3, Point::Y, 1.0));
    assert!(game.launch(3, Point::Y, 1.0));
    assert_eq!(game.slots, [None, None, before[0], before[1]]);
    assert_eq!(game.rng, rng);

    game.balls.retain(|body| body.identity != blocker);
    advance(&mut game, 120);
    assert!(game.slots.iter().all(Option::is_some));
    assert_eq!(game.slots[2..], [before[0], before[1]]);
    assert!(game.slots[0].unwrap().id > game.slots[1].unwrap().id);
    assert_ne!(game.rng, rng);
}

#[test]
fn supply_sequence_only_advances_after_successful_actions() {
    let mut first = Game::new(3141);
    let mut second = Game::new(3141);
    assert_eq!(first.slots, second.slots);
    assert!(!first.launch(1, Point::default(), 0.5));
    assert!(!first.launch(1, Point::Y, f32::NAN));
    assert!(!first.launch(RACK_SLOTS, Point::Y, 0.5));
    assert_eq!(first.slots, second.slots);

    for game in [&mut first, &mut second] {
        assert!(game.launch(0, Point::Y, 0.8));
        assert_eq!(game.slots[0], None);
        advance(game, 50);
    }
    assert_eq!(first.slots, second.slots);
    assert!(first.slots[0].is_some());
    assert_eq!(first.shots, 1);
}

#[test]
fn launch_availability_checks_every_entry_and_its_own_ball_size() {
    let mut game = Game::new(9);
    let hold = game.rack_centers()[0];
    test_ball(&mut game, 3, hold.x - 34.0, hold.y, 0.0, 0.0);
    game.launch_mask = game.unblocked_entries();
    assert_eq!(game.launch_mask, 0b1110);
    assert!(!game.launch(0, Point::Y, 0.8));
    assert!(game.launch(1, Point::Y, 0.8));
}

#[test]
fn single_rail_and_transient_pressure_do_not_end_a_run() {
    let mut game = Game::new(9);
    game.pressure = [1.0, 0.0];
    game.launch_mask = 0;
    for _ in 0..500 {
        game.evaluate_danger();
    }
    assert!(!game.ended);
    assert_eq!(game.danger_ticks, 0);
    game.pressure = [1.0, 1.0];
    for _ in 0..DANGER_CONFIRM_STEPS - 1 {
        game.evaluate_danger();
    }
    assert!(!game.ended);
    game.pressure[0] = 0.7;
    game.evaluate_danger();
    assert_eq!(game.danger_ticks, 0);
}

#[test]
fn a_rail_with_remaining_travel_offers_an_alternate_clear_entry() {
    let mut game = Game::new(9);
    for (index, point) in game.rack_centers().into_iter().enumerate() {
        test_ball(&mut game, index as u32 + 4, point.x, point.y, 0.0, 0.0);
    }
    game.pressure = [1.0, 0.72];
    game.launch_mask = game.unblocked_entries();
    assert_ne!(game.launch_mask, 0);
    assert!(game.launch_entries[0].x > 540.0);
    assert!(game.launch(0, Point::Y, 0.4));
}

#[test]
fn rails_compress_from_a_hit_and_recover_after_load_is_released() {
    let mut game = Game::new(9);
    test_ball(&mut game, 6, LEFT + 68.0, 182.0, -980.0, 0.0);
    game.advance();
    assert!(game.pressure[0] > 0.3);
    assert_eq!(game.pressure[1], 0.0);
    advance(&mut game, 180);
    assert!(game.pressure[0] < 0.01);
}

#[test]
fn sustained_two_rail_jam_ends_at_two_seconds_and_blocks_input() {
    let mut game = Game::new(9);
    for (index, point) in game.rack_centers().into_iter().enumerate() {
        test_ball(&mut game, index as u32 + 4, point.x, point.y, 0.0, 0.0);
    }
    game.pressure = [1.0, 1.0];
    game.launch_mask = game.unblocked_entries();
    assert_eq!(game.launch_mask, 0);
    for _ in 0..DANGER_CONFIRM_STEPS - 1 {
        game.evaluate_danger();
    }
    assert!(!game.ended);
    game.evaluate_danger();
    assert!(game.ended);
    assert!(!game.launch(0, Point::Y, 0.6));
}

#[test]
fn a_merge_that_reopens_an_entry_clears_the_jam() {
    let mut game = Game::new(9);
    for slot in 0..RACK_SLOTS {
        game.slots[slot] = Some(game.identity(2));
    }
    let entry = game.primary_entry(0);
    let radius = physics::radius(game.slots[0].unwrap().level);
    game.pressure = [1.0, 1.0];
    test_ball(&mut game, 1, entry.x - radius - 22.0, entry.y, 0.0, 0.0);
    test_ball(&mut game, 1, entry.x - radius - 67.0, entry.y, 0.0, 0.0);
    for point in game.rack_centers().into_iter().skip(1) {
        test_ball(&mut game, 1, point.x, point.y + 53.0, 0.0, 0.0);
    }
    game.launch_mask = game.unblocked_entries();
    assert_eq!(game.launch_mask, 0);
    game.evaluate_danger();
    assert_eq!(game.danger_ticks, 1);
    game.advance();
    assert_eq!(game.merges, 1);
    assert_ne!(game.launch_mask & 0b001, 0);
    assert_eq!(game.danger_ticks, 0);
}

#[test]
fn paused_run_cannot_accumulate_danger_move_or_refill() {
    let mut game = Game::new(1);
    assert!(game.launch(0, Point::Y, 0.65));
    game.danger_ticks = 18;
    let start_y = game.balls[0].position.y;
    game.paused = true;
    advance(&mut game, 500);
    assert_eq!(game.danger_ticks, 18);
    assert_eq!(game.balls[0].position.y, start_y);
    assert_eq!(game.slots[0], None);
    assert_eq!(game.legal_launches(), 0);
}

#[test]
fn scores_and_merges_survive_the_8192_milestone_and_integer_boundaries() {
    let mut game = Game::new(9);
    let a = game.identity(13);
    let b = game.identity(13);
    let merged = game.merge(a, b, Point::default(), None);
    assert_eq!(merged.level, 14);
    assert_eq!(game.score_text, "16384");
    let a = game.identity(69);
    let b = game.identity(69);
    game.merge(a, b, Point::default(), None);
    assert_eq!(game.score_text, "1180591620717411319808");
    assert_eq!(game.achievement_flags(99), 0b10111);
    assert_eq!(game.achievement_flags(100), 0b11111);
    let mut score = Score::default();
    score.add_power_of_two(31);
    score.add_power_of_two(31);
    assert_eq!(score.decimal(), "4294967296");
}
