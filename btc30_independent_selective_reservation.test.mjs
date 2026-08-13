import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBtc30IndependentFair,
  payoutReservationPct,
  quoteBtc30AgainstCompetition,
} from "./btc30_independent_selective_reservation.mjs";

test("safe random evaluates both sides independently", () => {
  const quote = quoteBtc30AgainstCompetition(
    { depth20Mean10: .02, net2Bps: .02, net10Bps: .05, net300Bps: .1, path30Bps: 1.2, orderbookAgeMs: 100 },
    { higherPayoutPct: 88, lowerPayoutPct: 88 },
  );
  assert.equal(quote.confidenceClass, "safe_random");
  assert.equal(quote.competitionMode, "both");
  assert.equal(quote.higher.competes, true);
  assert.equal(quote.lower.competes, true);
});

test("readable direction chases only the favored side", () => {
  const quote = quoteBtc30AgainstCompetition(
    { depth20Mean10: .65, net2Bps: -.3, net10Bps: 2.2, net300Bps: -2, path30Bps: 3, orderbookAgeMs: 100 },
    { higherPayoutPct: 78, lowerPayoutPct: 78 },
  );
  assert.equal(quote.favoredSide, "Higher");
  assert.equal(quote.competitionMode, "favored");
  assert.equal(quote.higher.competes, true);
  assert.equal(quote.lower.competes, false);
});

test("dangerous uncertainty never pips either competitor side", () => {
  const quote = quoteBtc30AgainstCompetition(
    { depth20Mean10: .5, net2Bps: 1, net10Bps: -1, net300Bps: -1, path30Bps: 6, orderbookAgeMs: 100 },
    { higherPayoutPct: 60, lowerPayoutPct: 60 },
  );
  assert.equal(quote.confidenceClass, "dangerous_uncertainty");
  assert.equal(quote.competitionMode, "off");
  assert.equal(quote.higher.competes, false);
  assert.equal(quote.lower.competes, false);
});

test("each side has its own probability reservation ceiling", () => {
  assert.ok(payoutReservationPct(.52, 5) < payoutReservationPct(.48, 5));
  const fair = evaluateBtc30IndependentFair({
    depth20Mean10: -.7, net2Bps: .2, net10Bps: -2, net300Bps: 2, path30Bps: 3, orderbookAgeMs: 100,
  });
  assert.equal(fair.favoredSide, "Lower");
});
