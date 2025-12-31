// Central tuning knobs shared by gameplay and editor.

// Jetpack energy capacity (0..1 scale).
export const JET_MAX_ENERGY = 1.0

// Jetpack forward assist while thrusting (px/s^2).
// Always adds a small +X push; when sliding backwards, an extra boost is applied (see sim).
export const JET_FWD_ACCEL = 130
export const JET_BACK_BOOST_ACCEL = 820

// Boost rail acceleration applied along the current ground tangent while grounded (px/s^2).
export const BOOST_ACCEL = 1100


