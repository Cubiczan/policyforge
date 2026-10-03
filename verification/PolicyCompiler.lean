/-
  PolicyForge — Lean 4 model of the policy compiler's treasury fragment.

  Source:  src/lib/policy-compiler.ts (compilePolicy + compileTreasuryContract
           + compileTimelockContract), src/lib/policy-types.ts.
  See NOTES.md for the theorem → source-line mapping and risk notes.

  The modelled fragment is the treasury tier authorisation decision for a
  single transfer: which tier governs an amount, which checks the source
  policy requires for that tier, and which checks the generated Solidity
  actually performs.  On top of that we model `compilePolicy`'s validation
  and the timelock contract's `emergencyExecute` access rule.

  Modelling choices (faithful to the code):
  * Amounts are in token base units.  Both source and compiled caps are
    `n * 10^6` for a numeric amount string `n`, matching the `* 1e6`
    emitted at policy-compiler.ts:185 (and 226/235).
  * The `amount` field is abstracted to `AmtTok`: the compiler's behaviour
    depends only on whether the string is numeric, the word "unlimited",
    or anything else (anything else is emitted verbatim into the Solidity,
    producing an uncompilable contract).
  * Time strings are abstracted to `TSpec`: `parseTimeToSeconds`
    (ll. 11–24) accepts only `^(\d+)\s*(second|minute|hour|day|week)s?$`;
    every other shape maps to "0".
-/

namespace PolicyForge

/-! ## Time parsing (policy-compiler.ts ll. 11–24) -/

inductive Unit where
  | second | minute | hour | day | week
  deriving DecidableEq, Repr

/-- The multiplier table of `parseTimeToSeconds` (ll. 16–22). -/
def mult : Unit → Nat
  | .second => 1
  | .minute => 60
  | .hour => 3600
  | .day => 86400
  | .week => 604800

/-- A duration string, classified by whether it matches the regex at l. 12.
    `abbrev` covers shapes like "24h" or "48h" (used throughout the shipped
    example policy); `other` covers everything else the regex rejects. -/
inductive TSpec where
  | spelled (n : Nat) (u : Unit)
  | abbrev (n : Nat) (c : Char)
  | other (s : String)
  deriving DecidableEq, Repr

/-- `parseTimeToSeconds`: spelled-out durations convert; anything the regex
    rejects silently becomes 0 (l. 13). -/
def parseTime : TSpec → Nat
  | .spelled n u => n * mult u
  | _ => 0

theorem parseTime_spelled (n : Nat) (u : Unit) : parseTime (.spelled n u) = n * mult u := rfl

theorem parseTime_abbrev (n : Nat) (c : Char) : parseTime (.abbrev n c) = 0 := rfl

/-- The shipped example policy writes every period as "24h"
    (policy-types.ts ll. 56–74, README example).  The compiler reads that
    as a 0-second window, not 86400. -/
example : parseTime (.abbrev 24 'h') = 0 ∧ 24 * mult .hour = 86400 := ⟨rfl, rfl⟩

/-! ## Treasury tiers: source and compiled reading -/

/-- A requirement from a tier's `requires` list.  Only the three shapes the
    compiler recognises exist here; unrecognised strings are silently
    dropped by the compiler (see NOTES).  `timelock d` is the requirement
    written `timelock_<d seconds>` in the source language, e.g.
    "timelock_48h" ↦ `timelock 172800`. -/
inductive Req where
  | multisig (k n : Nat)
  | timelock (delay : Nat)
  | vote
  deriving DecidableEq, Repr

/-- The tier `amount` field: a numeric token count, the word "unlimited",
    or any other string (emitted verbatim by the compiler). -/
inductive AmtTok where
  | numeric (n : Nat)
  | unlimitedWord
  | garbage
  deriving DecidableEq, Repr

structure Tier where
  amt : AmtTok
  currency : String
  period : TSpec
  requires : List Req
  allowSingle : Bool
  deriving DecidableEq, Repr

/-- A cap: unbounded, a finite base-unit bound, or `invalid` — a tier whose
    emitted Solidity mentions a non-numeric literal, so the generated
    contract does not compile at all. -/
inductive Cap where
  | inf | fin (n : Nat) | invalid
  deriving DecidableEq, Repr

/-- Source reading of a tier cap, from the `amount` field
    (policy-types.ts ll. 21–27; example: `amount: "unlimited"`). -/
def srcCap (t : Tier) : Cap :=
  match t.amt with
  | .numeric n => .fin (n * 1000000)
  | .unlimitedWord => .inf
  | .garbage => .invalid

/-- Compiled reading of a tier cap.  The compiler tests
    `limit.currency === "unlimited"` (ll. 75–76, 184, 226, 235) — the
    *currency* field — and otherwise emits `limit.amount` verbatim, which
    is a number only for numeric amount strings. -/
def cmpCap (t : Tier) : Cap :=
  if t.currency = "unlimited" then .inf
  else match t.amt with
       | .numeric n => .fin (n * 1000000)
       | _ => .invalid

/-- `amount <= cap` as the generated dispatch tests it (`amount <= X * 1e6`,
    l. 185).  An invalid cap never matches (the contract carrying it does
    not compile; see `cmpValid`). -/
def leCap (a : Nat) : Cap → Bool
  | .inf => true
  | .fin n => a ≤ n
  | .invalid => false

/-! ## Execution context -/

structure Ctx where
  /-- Distinct approvals actually collected for this transfer. -/
  approvals : Nat
  /-- Signers participating in the execution (1 = single signer). -/
  sigs : Nat
  /-- Seconds the transfer has actually waited under the timelock. -/
  waited : Nat
  /-- The generated `_timelockActive()`: a timelock address is set (l. 246). -/
  timelockConfigured : Bool
  /-- The generated `_governanceApproved()`: a governor address is set (l. 250). -/
  governorConfigured : Bool
  /-- A governance vote has actually approved this transfer. -/
  voteApproved : Bool
  /-- Base units already transferred inside the current window. -/
  priorSpend : Nat
  deriving DecidableEq, Repr

/-! ## Source semantics: what the policy says -/

def reqOkSrc : Req → Ctx → Bool
  | .multisig k _, c => c.approvals ≥ k
  | .timelock d, c => c.waited ≥ d
  | .vote, c => c.voteApproved

/-- Source period rule: within one `period`, total transfers stay within
    the tier's amount cap (the evident meaning of TreasuryLimit
    {amount, period}, policy-types.ts ll. 21–27). -/
def periodOkSrc (t : Tier) (c : Ctx) (a : Nat) : Bool :=
  match srcCap t with
  | .fin cap => c.priorSpend + a ≤ cap
  | .inf => true
  | .invalid => false

def tierOkSrc (t : Tier) (c : Ctx) (a : Nat) : Bool :=
  t.requires.all (fun r => reqOkSrc r c) &&
  (t.allowSingle || c.sigs ≥ 2) &&
  periodOkSrc t c a

/-- Source authorisation: the first tier (list order) whose cap covers the
    amount governs; its requirements decide.  No covering tier ⇒ denied. -/
def srcAllows : List Tier → Ctx → Nat → Bool
  | [], _, _ => false
  | t :: ts, c, a => if leCap a (srcCap t) then tierOkSrc t c a else srcAllows ts c a

/-! ## Compiled semantics: what the generated Solidity does -/

/-- The first `multisig_*` entry of `requires` (the compiler's `.find`,
    l. 74); only it is ever turned into a check. -/
def firstMsig : List Req → Option (Nat × Nat)
  | [] => none
  | Req.multisig k n :: _ => some (k, n)
  | _ :: rs => firstMsig rs

def hasTimelock : List Req → Bool
  | [] => false
  | Req.timelock _ :: _ => true
  | _ :: rs => hasTimelock rs

def hasVote : List Req → Bool
  | [] => false
  | Req.vote :: _ => true
  | _ :: rs => hasVote rs

/-- The generated `_checkTierN()` body (ll. 79–91):
    * multisig: `require(_countApprovals() >= k)` where `_countApprovals()`
      is the placeholder that always returns 1 (ll. 241–244);
    * timelock: `require(_timelockActive())` — an address is configured,
      the required delay is never consulted (ll. 246–248);
    * vote: `require(_governanceApproved())` — a governor address exists,
      no vote on this transfer is consulted (ll. 250–252);
    * `allow_single_signer` is never read anywhere in the compiler. -/
def cmpReqsOk (t : Tier) (c : Ctx) : Bool :=
  (match firstMsig t.requires with
   | some (k, _) => 1 ≥ k
   | none => true) &&
  (if hasTimelock t.requires then c.timelockConfigured else true) &&
  (if hasVote t.requires then c.governorConfigured else true)

/-- A policy compiles to a deployable contract only if every tier's cap
    literal is valid: the amounts are emitted into four places in the
    treasury template regardless of reachability (ll. 79, 185, 226, 235). -/
def cmpValid (tiers : List Tier) : Bool :=
  tiers.all (fun t => decide (cmpCap t ≠ Cap.invalid))

/-- The if / else-if dispatch chain of `executeTransfer` (ll. 183–189):
    first matching tier's check runs; if no tier matches, *no* check runs. -/
def cmpDispatch : List Tier → Ctx → Nat → Bool
  | [], _, _ => true
  | t :: ts, c, a => if leCap a (cmpCap t) then cmpReqsOk t c else cmpDispatch ts c a

/-- `_getPeriodLimit(amount)` (ll. 224–231): the *period in seconds* of the
    first matching tier, else of the last tier, else the "24 hours"
    fallback — returned where an amount limit is expected. -/
def cmpWindowAux (lastP : Nat) : List Tier → Nat → Nat
  | [], _ => lastP
  | t :: ts, a => if leCap a (cmpCap t) then parseTime t.period
                  else cmpWindowAux (parseTime t.period) ts a

def cmpWindow (tiers : List Tier) (a : Nat) : Nat := cmpWindowAux 86400 tiers a

/-- The generated `executeTransfer` period check (ll. 191–195):
    `periodSpend + amount > periodLimit` reverts — with `periodLimit`
    being a duration in seconds used as an amount bound. -/
def cmpAllows (tiers : List Tier) (c : Ctx) (a : Nat) : Bool :=
  cmpValid tiers && cmpDispatch tiers c a && (c.priorSpend + a ≤ cmpWindow tiers a)

/-! ## Selection fidelity: the one structural property that holds -/

def srcSelect : List Tier → Nat → Option Tier
  | [], _ => none
  | t :: ts, a => if leCap a (srcCap t) then some t else srcSelect ts a

def cmpSelect : List Tier → Nat → Option Tier
  | [], _ => none
  | t :: ts, a => if leCap a (cmpCap t) then some t else cmpSelect ts a

/-- If every tier's compiled cap agrees with its source cap, the compiled
    dispatch selects exactly the tier the source selects.  All divergences
    below come from cap *disagreement*, from the checks, or from the
    period rule — not from tier selection order. -/
theorem select_agree {tiers : List Tier} (h : ∀ t ∈ tiers, cmpCap t = srcCap t)
    (a : Nat) : cmpSelect tiers a = srcSelect tiers a := by
  induction tiers with
  | nil => rfl
  | cons t ts ih =>
      have ht : cmpCap t = srcCap t := h t List.mem_cons_self
      have ih' := ih (fun x hx => h x (List.mem_cons_of_mem t hx))
      simp only [cmpSelect, srcSelect, ht]
      split
      · rfl
      · exact ih'

/-- Source side of the overshoot hole: if no tier's cap covers the amount,
    the source policy denies the transfer. -/
theorem srcAllows_false_of_no_match {tiers : List Tier} {c : Ctx} {a : Nat}
    (h : ∀ t ∈ tiers, leCap a (srcCap t) = false) : srcAllows tiers c a = false := by
  induction tiers with
  | nil => rfl
  | cons t ts ih =>
      have ht : leCap a (srcCap t) = false := h t List.mem_cons_self
      have ih' := ih (fun x hx => h x (List.mem_cons_of_mem t hx))
      simp only [srcAllows, ht, Bool.false_eq_true, ite_false]
      exact ih'

/-- Compiled side: if no tier's cap covers the amount, the dispatch chain
    runs no check at all. -/
theorem cmpDispatch_true_of_no_match {tiers : List Tier} {c : Ctx} {a : Nat}
    (h : ∀ t ∈ tiers, leCap a (cmpCap t) = false) : cmpDispatch tiers c a = true := by
  induction tiers with
  | nil => rfl
  | cons t ts ih =>
      have ht : leCap a (cmpCap t) = false := h t List.mem_cons_self
      have ih' := ih (fun x hx => h x (List.mem_cons_of_mem t hx))
      simp only [cmpDispatch, ht, Bool.false_eq_true, ite_false]
      exact ih'

/-- Overshoot, general form: a transfer larger than every tier cap is
    authorised by the compiled contract whenever it fits under the
    seconds-as-amount period bound — the source denies it outright
    (`srcAllows_false_of_no_match`). -/
theorem cmp_overshoot {tiers : List Tier} {c : Ctx} {a : Nat}
    (hvalid : cmpValid tiers = true)
    (hnone : ∀ t ∈ tiers, leCap a (cmpCap t) = false)
    (hwin : c.priorSpend + a ≤ cmpWindow tiers a) :
    cmpAllows tiers c a = true := by
  simp [cmpAllows, hvalid, cmpDispatch_true_of_no_match hnone, hwin]

/-! ## Counterexamples: compilation changes the meaning

    Each is a concrete, decidable witness.  Amounts are base units;
    caps of `numeric n` are `n * 10^6`. -/

/-- C1 — Overshoot fall-through.  One tier capped at 10,000 tokens with a
    (regex-valid) 20,000-week period; an 11,000-token transfer matches no
    tier, so the compiled contract runs no tier check and the
    (seconds-valued) period bound 12,096,000,000 does not stop it.
    Source denies; compiled allows. -/
example :
    let tiers := [⟨AmtTok.numeric 10000, "USDC", TSpec.spelled 20000 Unit.week, [], true⟩]
    let c : Ctx := ⟨0, 1, 0, false, false, false, 0⟩
    srcAllows tiers c 11000000000 = false ∧ cmpAllows tiers c 11000000000 = true := by decide

/-- C2 — Period-limit units confusion.  A 5,000-token transfer inside a
    10,000-token daily tier, multisig satisfied: the source allows it.
    The compiled period check compares the amount against the window
    length in seconds (86,400), so it reverts. -/
example :
    let tiers := [⟨AmtTok.numeric 10000, "USDC", TSpec.spelled 24 Unit.hour,
                    [Req.multisig 1 3], true⟩]
    let c : Ctx := ⟨1, 1, 0, false, false, false, 0⟩
    srcAllows tiers c 5000000 = true ∧ cmpAllows tiers c 5000000 = false := by decide

/-- C3a — `_countApprovals()` placeholder, denying direction.  A tier
    requiring multisig 3-of-5 with all 5 approvals collected: the source
    allows; the compiled check `1 >= 3` always fails, so the tier is
    unusable. -/
example :
    let tiers := [⟨AmtTok.numeric 100000, "USDC", TSpec.spelled 10000 Unit.week,
                    [Req.multisig 3 5], true⟩]
    let c : Ctx := ⟨5, 5, 0, false, false, false, 0⟩
    srcAllows tiers c 50000000 = true ∧ cmpAllows tiers c 50000000 = false := by decide

/-- C3b — `_countApprovals()` placeholder, allowing direction.  A tier
    requiring multisig 1-of-3 with *zero* approvals collected: the source
    denies; the compiled check `1 >= 1` passes unconditionally. -/
example :
    let tiers := [⟨AmtTok.numeric 10000, "USDC", TSpec.spelled 2 Unit.week,
                    [Req.multisig 1 3], true⟩]
    let c : Ctx := ⟨0, 1, 0, false, false, false, 0⟩
    srcAllows tiers c 100000 = false ∧ cmpAllows tiers c 100000 = true := by decide

/-- C4 — Timelock delay dropped.  The tier requires `timelock_48h`; the
    transfer has waited 0 seconds, but a timelock address is configured.
    The compiled `_timelockActive()` is satisfied; the source is not. -/
example :
    let tiers := [⟨AmtTok.numeric 10000, "USDC", TSpec.spelled 2 Unit.week,
                    [Req.timelock 172800], true⟩]
    let c : Ctx := ⟨0, 1, 0, true, false, false, 0⟩
    srcAllows tiers c 100000 = false ∧ cmpAllows tiers c 100000 = true := by decide

/-- C5 — Governance vote replaced by governor existence.  The tier
    requires `governance_vote`; no vote approved this transfer, but a
    governor address is configured.  Compiled allows; source denies. -/
example :
    let tiers := [⟨AmtTok.numeric 10000, "USDC", TSpec.spelled 2 Unit.week,
                    [Req.vote], true⟩]
    let c : Ctx := ⟨0, 1, 0, false, true, false, 0⟩
    srcAllows tiers c 100000 = false ∧ cmpAllows tiers c 100000 = true := by decide

/-- C6 — "unlimited" read from the wrong field.  The shipped example's
    third tier is `amount: "unlimited", currency: "USDC"`.  The compiler
    tests the currency, so the amount word is emitted verbatim and the
    generated contract does not compile at all: the compiled policy
    authorises nothing, while the source authorises this (fully
    requirement-satisfying) transfer. -/
def exampleUnlimitedTier : Tier :=
  ⟨AmtTok.unlimitedWord, "USDC", TSpec.spelled 2 Unit.week,
   [Req.vote, Req.timelock 172800], false⟩

example :
    let c : Ctx := ⟨0, 3, 200000, true, true, true, 0⟩
    srcAllows [exampleUnlimitedTier] c 1000000000 = true ∧
    cmpAllows [exampleUnlimitedTier] c 1000000000 = false := by decide

/-- C6′ — The poison is total: with that tier present, *every* request is
    unauthorised by the compiled artifact, whatever the context. -/
theorem cmpAllows_unlimited_tier_poison (c : Ctx) (a : Nat) :
    cmpAllows [exampleUnlimitedTier] c a = false := by
  have hv : cmpValid [exampleUnlimitedTier] = false := by decide
  simp only [cmpAllows, hv, Bool.false_and]

/-- C7 — `allow_single_signer: false` is dropped.  A tier with no other
    requirements forbidding single-signer execution: the compiler emits
    only the comment "// Single-signer authorized" (l. 87), so a lone
    signer executes.  Source denies; compiled allows. -/
example :
    let tiers := [⟨AmtTok.numeric 10000, "USDC", TSpec.spelled 2 Unit.week, [], false⟩]
    let c : Ctx := ⟨0, 1, 0, false, false, false, 0⟩
    srcAllows tiers c 100000 = false ∧ cmpAllows tiers c 100000 = true := by decide

/-- C8 — `currency: "unlimited"` invents an unbounded tier.  A tier the
    source caps at 500 tokens becomes unbounded in the compiled reading
    because the compiler keys "unlimited" on the currency field: a
    600-token transfer the source denies is authorised. -/
example :
    let tiers := [⟨AmtTok.numeric 500, "unlimited", TSpec.spelled 10000 Unit.week, [], true⟩]
    let c : Ctx := ⟨0, 1, 0, false, false, false, 0⟩
    srcAllows tiers c 600000000 = false ∧ cmpAllows tiers c 600000000 = true := by decide

/-- Sanity: the model is not vacuous — on a small, fully-satisfying
    transfer both readings agree to allow. -/
example :
    let tiers := [⟨AmtTok.numeric 10000, "USDC", TSpec.spelled 24 Unit.hour,
                    [Req.multisig 1 3], true⟩]
    let c : Ctx := ⟨1, 1, 0, false, false, false, 0⟩
    srcAllows tiers c 100 = true ∧ cmpAllows tiers c 100 = true := by decide

/-! ## Validation (compilePolicy, ll. 569–601) -/

/-- A policy document, abstracted to what validation looks at: presence
    of the scalar sections and *counts* where the code checks
    non-emptiness (ll. 590–597).  `timelock` is carried because code
    generation — unlike validation — depends on it. -/
structure Doc where
  name : Option String
  version : Option String
  network : Option String
  roles : Nat
  limits : Nat
  proposals : Option Nat
  timelock : Option (Nat × Nat)
  deriving DecidableEq, Repr

/-- The validation of ll. 590–597, verbatim in structure and messages. -/
def validate (d : Doc) : List String :=
  (if d.name.isNone then ["Missing required field: name"] else []) ++
  (if d.version.isNone then ["Missing required field: version"] else []) ++
  (if d.network.isNone then ["Missing required field: network"] else []) ++
  (if d.roles = 0 then ["At least one role must be defined"] else []) ++
  (if d.limits = 0 then ["At least one treasury limit tier must be defined"] else []) ++
  (if d.proposals.isNone then ["Missing required section: proposals"] else [])

/-- `compilePolicy` returns contracts iff the error list is empty
    (early return at ll. 599–601). -/
def producesContracts (d : Doc) : Bool := (validate d).isEmpty

/-- Validation is *sound* for the fields it checks: a missing name is
    always rejected.  (One instance shown; the other five checks are
    identical in shape.) -/
theorem validate_ne_of_missing_name {d : Doc} (h : d.name = none) :
    validate d ≠ [] := by
  simp [validate, h]

/-- Rejected policies produce no contracts. -/
theorem no_contracts_of_errors {d : Doc} (h : validate d ≠ []) :
    producesContracts d = false := by
  cases hv : validate d with
  | nil => exact absurd hv h
  | cons x xs => simp [producesContracts, hv]

/-- `compileGovernorContract` dereferences `timelock.min_delay`
    unconditionally (l. 358, and ll. 449–450 in the timelock compiler's
    caller path), so a document without a timelock section cannot be
    compiled — the TypeScript throws, and the API route surfaces it as an
    HTTP 500 (src/app/api/compile/route.ts ll. 19–24). -/
def governorDefined (d : Doc) : Bool := d.timelock.isSome

/-- Validation is *incomplete*: a document can pass every validation
    check yet be uncompilable, because validation never checks the
    timelock section that code generation requires. -/
example :
    let d : Doc := ⟨some "DAO Treasury", some "1.0.0", some "ethereum", 4, 3, some 4, none⟩
    validate d = [] ∧ producesContracts d = true ∧ governorDefined d = false := by
  decide

/-! ## Timelock bypass (compileTimelockContract, ll. 487–508) -/

structure Caller where
  /-- Policy roles the caller actually holds (e.g. "admin"). -/
  roles : List String
  /-- Holds OpenZeppelin's DEFAULT_ADMIN_ROLE (in the generated setup:
    only the deployer, via `generateRoleSetup`). -/
  isDefaultAdmin : Bool
  /-- Holds the generated `<role>_BYPASS` constants.  No generated code
    ever grants these (generateRoleSetup grants `<NAME>_ROLE`, a
    different constant), so in generated deployments this is empty. -/
  bypassRoles : List String
  deriving DecidableEq, Repr

/-- Source reading of `roles_can_bypass`: a caller bypasses if they hold
    any one of the listed roles. -/
def srcBypass (bypass : List String) (c : Caller) : Bool :=
  bypass.any (fun r => decide (r ∈ c.roles))

/-- Compiled reading of `emergencyExecute` (ll. 499–508): one `require`
    is emitted per bypass role, each demanding that role's `_BYPASS`
    constant *or* DEFAULT_ADMIN_ROLE — a conjunction over all roles.
    With an empty bypass list, no `require` is emitted at all. -/
def cmpBypass (bypass : List String) (c : Caller) : Bool :=
  c.isDefaultAdmin || bypass.all (fun r => decide (r ∈ c.bypassRoles))

/-- B1 — Empty bypass list: the source lets nobody bypass; the compiled
    `emergencyExecute` has no access check whatsoever and lets
    *everybody* bypass the timelock. -/
theorem bypass_empty_compiled_open (c : Caller) : cmpBypass [] c = true := by
  simp [cmpBypass]

theorem bypass_empty_source_closed (c : Caller) : srcBypass [] c = false := rfl

/-- B2 — Listed bypass role does not work: a caller holding the policy's
    "admin" role (the shipped example's only bypass role,
    policy-types.ts l. 130) cannot use `emergencyExecute` in the compiled
    contract, since the check demands the never-granted `ADMIN_BYPASS`
    constant or DEFAULT_ADMIN_ROLE.  Source allows; compiled denies. -/
example :
    let c : Caller := ⟨["admin"], false, []⟩
    srcBypass ["admin"] c = true ∧ cmpBypass ["admin"] c = false := by decide

/-- B3 — Unlisted deployer can bypass: the deployer holds
    DEFAULT_ADMIN_ROLE from the generated setup, which satisfies every
    emitted `require` — even when the policy lists a bypass role the
    deployer does not hold as a policy role. -/
example :
    let c : Caller := ⟨[], true, []⟩
    srcBypass ["guardian"] c = false ∧ cmpBypass ["guardian"] c = true := by decide

end PolicyForge
