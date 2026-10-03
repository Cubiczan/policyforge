# PolicyForge — verification notes

Model: [`PolicyCompiler.lean`](PolicyCompiler.lean) (Lean 4.34.1, core library
only). Reproduce: `~/.elan/bin/lean PolicyCompiler.lean` — exit 0, no
warnings. No `sorry`/`admit`/custom axioms; `#print axioms` on the headline
theorems shows only `propext`.

**Scope.** A faithful fragment: the treasury tier authorisation decision
(source YAML policy vs. the generated `PolicyTreasury.executeTransfer`),
`compilePolicy`'s validation, and `PolicyTimelock.emergencyExecute`'s access
rule. OpenZeppelin internals, the Governor's vote counting, deployment, and
YAML parsing itself are out of fragment. All line numbers refer to
`src/lib/policy-compiler.ts` unless a file is named.

**Abstractions.** The tier `amount` string is modelled as `AmtTok`
(numeric / "unlimited" / other) because the compiler's behaviour depends
only on that classification — anything non-numeric is emitted verbatim.
Duration strings are `TSpec` (spelled / abbreviated / other) because
`parseTimeToSeconds` (ll. 11–24) accepts only
`^(\d+)\s*(second|minute|hour|day|week)s?$`. Amounts are base units; both
readings scale a numeric amount by 10⁶, as the template does (l. 185).

## Headline findings

1. **Compiler soundness fails in both directions** for the treasury
   fragment: there are policies and transfers the source allows and the
   compiled contract denies (C2, C3a, C6), and transfers the source denies
   and the compiled contract allows (C1, C3b, C4, C5, C7, C8). The one
   structural property that *does* hold is tier-selection fidelity under
   cap agreement (`select_agree`).
2. **The repo's own example policy compiles to Solidity that cannot
   compile**, via at least three independent routes (C6; NOTES-only
   findings A and B below).
3. **The timelock bypass is inverted**: with `roles_can_bypass: []` the
   generated `emergencyExecute` is callable by *anyone* (B1); with a role
   listed, that role *cannot* use it (B2), while the deployer always can
   (B3).

## Theorem → source mapping

### Time parsing (`parseTimeToSeconds`, ll. 11–24)

| Lean | Claim | Source |
|---|---|---|
| `parseTime_spelled` | `parseTime (spelled n u) = n * mult u` — spelled durations convert per the multiplier table | ll. 12, 16–23 |
| `parseTime_abbrev` | Abbreviated shapes ("24h", "48h") parse to 0 (regex rejects them; function returns "0") | l. 13 |
| example (l. "24h") | The shipped example's period `"24h"` (policy-types.ts ll. 55–100, README) yields a 0-second window, not 86400 | policy-types.ts, EXAMPLE_POLICY |

### Tier selection (dispatch, ll. 178–196)

| Lean | Claim | Source |
|---|---|---|
| `select_agree` | If every tier's compiled cap equals its source cap, compiled dispatch selects the same tier as the source's first covering tier | dispatch chain ll. 183–189 |
| `srcAllows_false_of_no_match` | Source: no covering tier ⇒ transfer denied | source semantics of tiered limits (policy-types.ts ll. 21–27) |
| `cmpDispatch_true_of_no_match` | Compiled: no covering tier ⇒ **no `_checkTierN` runs at all** (bare fall-through of the if/else-if chain) | ll. 183–189 |
| `cmp_overshoot` | Compiled authorises an over-cap transfer whenever it fits the seconds-valued period bound | ll. 183–195, 224–231 |

### Counterexamples (all `by decide` witnesses in the model)

| ID | Direction | Root cause | Source lines |
|---|---|---|---|
| C1 overshoot | compiled allows / source denies | Fall-through above + period bound is a duration (see C2); witness uses a regex-valid 20,000-week period | ll. 183–195 |
| C2 period units | source allows / compiled denies | `_getPeriodLimit` returns the tier's period **in seconds** (l. 224–231) and `executeTransfer` compares `periodSpend + amount > periodLimit` (ll. 191–195): amounts are checked against 86,400 for a "24 hours" tier, so ordinary in-cap transfers revert | ll. 191–195, 214–231 |
| C3a placeholder approvals | source allows / compiled denies | `_countApprovals()` is a placeholder returning 1 (ll. 241–244); a multisig 3-of-5 tier's `require(_countApprovals() >= 3)` (l. 87) can never pass | ll. 87, 241–244 |
| C3b placeholder approvals | compiled allows / source denies | Same placeholder: a multisig 1-of-3 tier's check `1 >= 1` passes with **zero** approvals collected | ll. 87, 241–244 |
| C4 timelock delay dropped | compiled allows / source denies | `timelock_48h` compiles to `require(_timelockActive())` = "a timelock address is set" (ll. 88, 246–248); the 48h delay is never parsed or enforced | ll. 74–76, 88, 246–248 |
| C5 vote → existence | compiled allows / source denies | `governance_vote` compiles to `require(_governanceApproved())` = "a governor address is set" (ll. 89, 250–252); no vote on the transfer is consulted | ll. 89, 250–252 |
| C6 "unlimited" field mixup | compiled denies everything / source allows | The compiler tests `limit.currency === "unlimited"` (ll. 75–76, 184, 226, 235), but the source puts "unlimited" in `amount` (policy-types.ts l. 96). The word is emitted verbatim (`unlimited * 1e6`) → uncompilable Solidity | ll. 75–76, 184, 226, 235 |
| C6′ poison totality (`cmpAllows_unlimited_tier_poison`) | — | With such a tier present, `cmpAllows … = false` for **every** context and amount | as C6 |
| C7 single-signer | compiled allows / source denies | `allow_single_signer` (policy-types.ts l. 26) is **never read** in the compiler; a tier without other requirements emits only the comment `// Single-signer authorized` (l. 87) | l. 87; grep: no other occurrence |
| C8 currency "unlimited" | compiled allows / source denies | Dual of C6: `currency: "unlimited"` makes a 500-token tier unbounded in the compiled reading | ll. 75–76, 184 |
| sanity example | both allow | The model is not vacuous: a small fully-satisfying transfer is allowed by both readings | — |

### Validation (`compilePolicy`, ll. 569–665)

| Lean | Claim | Source |
|---|---|---|
| `validate_ne_of_missing_name` | A missing `name` always produces a non-empty error list (representative of the six checks) | l. 590 |
| `no_contracts_of_errors` | Non-empty errors ⇒ no contracts are produced (early return) | ll. 599–601 |
| validation-incompleteness example | A document can satisfy **all** validation checks (`validate d = []`, contracts produced) while `governorDefined d = false`: validation never checks `timelock`, but `compileGovernorContract` dereferences `timelock.min_delay` unconditionally → TypeError → HTTP 500 via the route's catch (src/app/api/compile/route.ts ll. 19–24) | ll. 590–597 vs. l. 358 |

So "invalid policies are rejected" is **half true**: the six checked
conditions are sound (errors ⇒ nothing is emitted), but validation is
incomplete — uncompilable inputs pass it, and the failure mode is an
exception, not an entry in `errors`.

### Timelock bypass (`compileTimelockContract`, ll. 447–510)

The generated `emergencyExecute` emits **one `require` per bypass role**
(l. 505), each demanding `hasRole(<ROLE>_BYPASS) || hasRole(DEFAULT_ADMIN_ROLE)`.

| Lean | Claim | Source |
|---|---|---|
| `bypass_empty_compiled_open` | `roles_can_bypass: []` ⇒ compiled allows **every** caller (no require emitted) | ll. 499–508 with l. 505 |
| `bypass_empty_source_closed` | Source: empty bypass list ⇒ nobody bypasses | policy-types.ts ll. 45–48 |
| B2 example | Caller holding the listed role "admin" (policy-types.ts l. 130), not deployer ⇒ source allows, compiled denies: `<ROLE>_BYPASS` constants are generated (l. 487) but **never granted anywhere**; `generateRoleSetup` grants `<NAME>_ROLE` instead (ll. 45–63) | ll. 487, 505; ll. 45–63 |
| B3 example | The deployer (DEFAULT_ADMIN_ROLE, granted at l. 57) satisfies every require and can bypass even for roles they don't hold | l. 57, l. 505 |

With several listed roles the compiled rule is a conjunction (all bypass
roles or admin), where the source lists roles that can *each* bypass.

## Further discrepancy / risk notes (not in the Lean fragment)

A. **Undefined `ADMIN_ROLE` in PolicyTreasury.** The treasury template
   defines only `TREASURER_ROLE`/`GUARDIAN_ROLE` (ll. 125–126), but its
   constructor runs `generateRoleSetup` over roles filtered to
   admin/treasurer/guardian (l. 173), which emits
   `_grantRole(ADMIN_ROLE, …)` for the admin role's members
   (ll. 45–63). `ADMIN_ROLE` is never defined in that contract (the
   helper `generateRoleConstants`, ll. 36–43, is dead code) — a second
   independent reason the example policy's output doesn't compile.

B. **Duplicate permission functions in PolicyAccessControl.**
   `permissionChecks` (ll. 367–376) names each generated function after
   the *permission* only. The example gives "pause" to both admin
   (policy-types.ts l. 106) and guardian (l. 114), generating two
   identical-signature `requirePause()` functions with different bodies —
   invalid Solidity. Third independent route to uncompilable output.

C. **Role-id mismatch across contracts.** PolicyAccessControl defines
   `TREASURER_ROLE = keccak256("treasurer")` (l. 397); PolicyTreasury
   defines `TREASURER_ROLE = keccak256("TREASURER_ROLE")` (l. 125). Same
   name, different role id — wiring the two contracts together grants
   nothing.

D. **Policy "admin" role ≠ DEFAULT_ADMIN_ROLE.** All generated admin
   functions (`addMember`/`removeMember`/batch, ll. 419–443; treasury
   `unpause`, l. 209) require DEFAULT_ADMIN_ROLE, which the setup grants
   only to the deployer (l. 57). Members of the policy's admin role get
   `ADMIN_ROLE` and cannot call them. (`const adminRole = roles[0]`,
   l. 55, is computed and unused.) Relatedly, the treasury setup filters
   roles **by name** (l. 173) — a transfer role named anything else is
   silently omitted — and role `permissions` are never consulted by the
   treasury (`onlyTreasurerOrAdmin` is hardcoded, ll. 159–163).

E. **Malformed requirements are silently dropped.** Only the *first*
   `multisig_*` entry is used (`.find`, l. 74); if it fails the regex in
   `parseMultisigRequirement` (ll. 30–34), `sig` is null and **no**
   approval check is emitted at all. Additional multisig entries and any
   unrecognised requirement strings are ignored without a warning.

F. **The emergency section is decorative.** It is read only for one
   warning (l. 608). `pause_enabled: false` still generates
   `pause()`/`unpause()`; `pause()` is hardcoded to GUARDIAN_ROLE,
   ignoring `pause_role`; `guardian_address` and `auto_unpause` are never
   compiled. Similarly `allow_delegation: false` appears only in comments
   (ll. 294, 537) — PolicyToken always enables delegation — and the
   timelock compiler's `proposers`/`executors` locals (ll. 451–458) are
   computed and never used.

G. **Unvalidated numbers are emitted verbatim.** `quorum_percentage` is
   never checked: a missing/NaN value puts the literal `NaN` into the
   Governor (ll. 26–28, 323) while `compilePolicy` still returns
   `errors: []` (hardcoded, l. 659). The compiled quorum also *floors*
   the declared percentage — `_token.getPastTotalSupply * bps / 10000`
   in integer arithmetic (l. 323): supply 130 at 4% yields a 5-vote
   quorum against a declared 5.2.

H. **Scaling and currency.** Every cap is scaled by a hardcoded `1e6`
   (ll. 79, 185, 226, 235), i.e. a 6-decimal token is assumed for all
   currencies; `currency` and `token_address` otherwise play no role in
   the generated treasury (the token is a constructor argument).

I. **Fall-through bookkeeping.** For over-cap transfers that slip through
   (C1), `_getTier` returns `limits.length` (ll. 233–240), so the
   `TransferExecuted` event reports a tier number that doesn't exist.
