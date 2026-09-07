---
inclusion: always
---

# Coaching safety and wellbeing guardrails

These constraints are not tunable, not A/B-testable, and not subject to product pressure.

## No medical or diagnostic claims

The system never states or implies a diagnosis, an injury risk, a pathology, or a
rehabilitation recommendation.

| Never generate | Generate instead |
|----------------|------------------|
| "You have a muscle imbalance" | "Left knee is tracking 8° shallower than right" |
| "This will hurt your back" | "Your torso angle changed 14° during the lift" |
| "You have poor mobility" | "Depth is 12 cm above your calibrated floor" |
| "Dysfunction detected" | (no such output exists) |

Words banned from all user-facing output: `injury`, `injure`, `dysfunction`, `pathology`,
`diagnose`, `imbalance`, `damage`, `dangerous`, `unsafe`, `corrective`.

Every surface that reports body or movement data carries: this is a movement-tracking tool,
not a medical device, and does not replace a qualified coach or clinician.

## Body composition and weight

The Body Scan and weight fields are the highest-risk surface in this product.

- Default **off**. Opt-in, with the opt-in never re-prompted after one decline.
- Never notify, remind, nudge, or badge on body metrics.
- Never render a streak, a goal gap, a target line, a "days since", or any progress bar on
  body or weight data.
- Report **ratios with confidence bands** (shoulder:waist, limb symmetry). Never absolute
  circumference or body-fat percentage — single-camera anthropometry cannot support it, and
  the false precision is the harm.
- Never combine body metrics with a score, grade, rank, or comparison to another person or
  to a population norm.
- Never generate aesthetic language: `lean`, `toned`, `shredded`, `flabby`, `too heavy`,
  `ideal weight`.
- Erasure of body data must be independently available from erasure of workout data.

## Cue discipline

- **One cue per rep. Never two.** Coaching that fires on every fault is noise the user learns
  to tune out, and it destroys the value of a real cue.
- Cue cooldown: the same cue ID is not repeated within 3 reps.
- Cues address the movement, not the person. "Knees out", not "you're letting your knees cave".
- Never issue a cue when landmark confidence for the relevant joints is below threshold.
  Silence is correct when the system does not know.
- No motivational content, no praise inflation, no exclamation marks. A counted rep is
  confirmed by a tone, not by "great job".

## Set termination

The system suggests ending a set. It never insists, never counts down against the user's
will, and never records a "failed" set. A decision to continue past the suggestion is
recorded without comment.
