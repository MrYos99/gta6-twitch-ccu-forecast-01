[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/MrYos99/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/MrYos99/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

# GTA VI launch-day Twitch viewer forecaster

Forecasts how many people watch Grand Theft Auto VI live on Twitch in each
hour of its release day (2026-11-19 UTC), hours 2–24, as five quantiles
(5%, 25%, 50%, 75%, 95%) of that hour's concurrent-viewer count. Entry for the
[make.fun bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01).

## Approach

Hour 1's print anchors the whole day — but the *shape* of the day depends
strongly on how big hour 1 already is. Across the case's comparable launches,
the log-ratio `ln(viewers_h / viewers_1)` is tightly (negatively) related to
`ln(viewers_1)`: a small hour 1 means most of the world has yet to unlock, so
the day rises steeply (up to ~30x for the smallest launches); a huge hour 1
means the launch is already at full strength and the day stays flat or dips.
The correlation between the log hour-1 print and the day's peak log-ratio is
about −0.94.

For each forecast hour `h = 2..24`, the program fits, on the clean
comparables only, the quadratic

```
ln(y_h / y_1) = a_h + b_h * ln(y_1) + c_h * ln(y_1)^2
```

and takes the residual standard deviation as the log spread, smoothed over
neighbouring hours and shrunk by 0.3 (tuned on the practice cases). The five
quantiles are then `p1 * exp(median_h + z_tau * sd_h)`, with `z` the standard
normal quantiles. The fitted median is clamped to [−1.5, 4.0] in log units so
a very large hour-1 print (GTA VI's could exceed every comparable) extrapolates
to a mildly declining day, never to anything absurd.

Comparables flagged in their unlock text as early-access-contaminated, weak
tier, or the target's own pre-release history are excluded: their release-day
curves are distorted (early access peaks days before release) and including
them measurably worsens the practice score. Everything is computed from the
case file at run time — no hardcoded curves — so the same program works on the
final case, whose comparables also include the four practice launches.

Ideas tried and rejected on the practice cases: an unconditioned median curve
(0.393), a linear (non-quadratic) fit (0.160), adding the pre-release level or
the channel count as predictors (0.159–0.173), k-nearest-neighbour curves
(0.178–0.222), aligning curves by the detected US-unlock jump hour (the jump
is too noisy to detect reliably), and empirical residual quantiles instead of
normal ones (0.167). The quadratic on `ln(y_1)` alone was the best simple
model on all four practice cases.

## Local practice grade

Practice answers were reconstructed from SullyGnome (the same source the
house uses) for the four practice launches and validated: the hour-1 print
matches each case's `known` exactly and every pre-checkpoint history point
matches with zero mismatches. Scores are mean pinball loss on the log scale
(lower is better), with typical miss and 90% coverage as reported by the
competition's scoring rules.

| case | launch | loss | typical miss | 90% coverage |
| --- | --- | --- | --- | --- |
| p00 | Marvel's Wolverine | 0.113 | 19.0% | 0.957 |
| p01 | Red Dead Redemption 2 | 0.155 | 29.7% | 0.870 |
| p02 | God of War Ragnarök | 0.121 | 22.0% | 0.957 |
| p03 | Marvel's Spider-Man 2 | 0.173 | 29.9% | 0.739 |
| **mean** | | **0.140** | **~25%** | **~0.88** |

House baseline (persistence) on the same cases: **0.387** (typical miss
~82.8%, 90% coverage ~0.783). This entry beats it by about 64% on the
practice. A prize needs a loss strictly below the best house entry on the
final (the baseline, or the house model forecast, whichever is lower).

## Running it

Node 22, standard library only, no network, deterministic (two runs write
the same bytes), ~0.3 s per case:

```
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out` to the
output directory: 23 rows, hours 2–24, each five quantiles above 0 and at
most 1e9, non-decreasing. If a case has too few clean comparables to fit the
curves, it falls back to the persistence forecast (every hour stays at hour
1's print, spread widening like a random walk).
