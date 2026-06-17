# PolicyForge — Governance-as-Code with OpenZeppelin

> Policy-as-Code engine that compiles declarative YAML governance rules into production-ready Solidity smart contracts using audited OpenZeppelin primitives.

**Write your governance rules in YAML. Get battle-tested Solidity contracts.**

```
treasury:
  limits:
    - amount: "10000"
      currency: "USDC"
      period: "24h"
      requires: ["multisig_1_of_3"]
    - amount: "100000"
      currency: "USDC"
      period: "24h"
      requires: ["timelock_48h", "multisig_3_of_5"]
    - amount: "unlimited"
      currency: "USDC"
      period: "24h"
      requires: ["governance_vote", "timelock_72h"]
```

Compile → 5 contracts, 378 lines, 11 OpenZeppelin imports. Zero hand-written Solidity.

---

## The Problem

Setting up on-chain governance is painful. OpenZeppelin provides the building blocks — Governor, TimelockController, AccessControl, ERC20Votes — but composing them into a working governance system requires:

1. **Deep Solidity expertise** — multiple inheritance, diamond-shaped dependency graphs, function selector clashes
2. **Hours of wiring** — constructor parameters, role grants, timelock proposers/executors, governor-token-timelock triangle
3. **No standard patterns** — every team wires OZ contracts differently, often incorrectly. Access control misconfigurations are the #1 vulnerability in the OWASP Smart Contract Top 10: 2026
4. **Governance as tribal knowledge** — "how should we configure quorum? What timelock delay? Who are the proposers?" These decisions are made ad-hoc, not codified

The result: teams either spend weeks on governance plumbing (and still get it wrong), or skip it entirely and get hacked.

## The Solution

**PolicyForge turns governance into code.** Define your rules in a declarative YAML policy — roles, treasury tiers, voting config, timelock settings — and PolicyForge compiles them into 5 production-ready Solidity contracts that inherit from audited OpenZeppelin primitives.

The key insight: most governance configuration is **structural, not behavioral**. The shape of your governance (how many approval tiers, what quorum, what timelock) can be expressed as data. Only the business logic needs to be Solidity. PolicyForge generates the structure; OpenZeppelin provides the security.

### What Gets Generated

| Contract | Inherits From | Purpose |
|----------|--------------|---------|
| `PolicyAccessControl` | OZ AccessControl | Role-based permissions with batch member management |
| `PolicyTimelock` | OZ TimelockController | Delayed execution with configurable min/max delays and role-based bypass |
| `PolicyToken` | OZ ERC20Votes, ERC20Permit | Governance token with voting checkpoints, delegation, and gasless approvals |
| `PolicyGovernor` | OZ Governor, GovernorTimelockControl, GovernorSettings | On-chain proposal creation, voting, and execution with configurable quorum |
| `PolicyTreasury` | OZ AccessControl, ReentrancyGuard, SafeERC20 | Tiered treasury with rate limiting, multisig requirements, and pause capability |

### Policy Schema

```yaml
name: "DAO Treasury"                    # Governance system name
version: "1.0.0"                        # Policy version
network: "ethereum"                     # Target chain
description: "..."                      # Human-readable description

roles:                                  # Define RBAC roles
  - name: "admin"
    description: "Full administration rights"
    members: ["0xAdmin1...", "0xAdmin2..."]
    permissions: ["pause", "unpause", "upgrade", "add_role", "remove_role"]

treasury:                               # Treasury tier configuration
  enabled: true
  token_address: "0x"
  limits:
    - amount: "10000"                   # Tier 1: small transfers
      currency: "USDC"
      period: "24h"
      requires: ["multisig_1_of_3"]     # Single-signer OK
      allow_single_signer: true
    - amount: "100000"                  # Tier 2: medium transfers
      currency: "USDC"
      period: "24h"
      requires: ["timelock_48h", "multisig_3_of_5"]
      allow_single_signer: false
    - amount: "unlimited"               # Tier 3: large transfers
      currency: "USDC"
      period: "24h"
      requires: ["governance_vote", "timelock_72h"]
      allow_single_signer: false

proposals:                              # Governor configuration
  quorum_percentage: 4                  # 4% quorum
  voting_delay: "1 day"
  voting_period: "5 days"
  proposal_threshold: "1000"
  allow_delegation: true

timelock:                               # Timelock constraints
  min_delay: "12 hours"
  max_delay: "30 days"
  roles_can_bypass: ["admin"]

emergency:                              # Emergency controls
  pause_enabled: true
  pause_role: "guardian"
  guardian_address: "0xGuardian..."
  auto_unpause: "72 hours"
```

## How It Works

```
YAML Policy
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  PolicyForge Compiler                                │
│                                                      │
│  1. Parse & validate YAML schema                     │
│  2. Generate role constants and setup functions      │
│  3. Compile treasury tiers → tiered check functions  │
│  4. Configure Governor (quorum, delays, thresholds)  │
│  5. Wire TimelockController (min/max, bypass)        │
│  6. Generate ERC20Votes token with delegation        │
│  7. Produce AccessControl with permission guards     │
│     ↓                                                │
│  5 Solidity contracts                                │
│  Correct deployment order                            │
│  All OZ imports tracked                              │
└──────────────────────────────────────────────────────┘
    │
    ▼
Production-ready .sol files
```

## Architecture

PolicyForge generates contracts in dependency order:

1. **PolicyAccessControl** — no on-chain dependencies, deployed first
2. **PolicyTimelock** — no on-chain dependencies, deployed standalone
3. **PolicyToken** — no on-chain dependencies, standalone ERC20
4. **PolicyGovernor** — requires Token address + Timelock address in constructor
5. **PolicyTreasury** — requires Token address + Timelock address in constructor

Each contract includes:
- Custom errors (not require strings) for gas efficiency
- NatSpec documentation with policy source attribution
- Role constants generated from YAML role definitions
- Constructor wiring with proper initialization
- Safety features: ReentrancyGuard, SafeERC20, access control on all entry points

## OpenZeppelin Contracts Used

PolicyForge generates contracts that compose **11 OpenZeppelin primitives**:

**Governance**: Governor, GovernorTimelockControl, GovernorSettings, GovernorCompatibilityBravo
**Security**: AccessControl, TimelockController, ReentrancyGuard
**Tokens**: ERC20Votes, ERC20Permit, SafeERC20, IERC20

Every generated contract inherits from audited, battle-tested OZ code. The OWASP Smart Contract Top 10: 2026 identifies access control issues as the #1 vulnerability — PolicyForge eliminates this by generating correct AccessControl configurations from policy.

## Live Demo

The web-based policy editor features:

- **YAML Editor** with line numbers and syntax-aware layout
- **Live Policy Preview** showing roles, treasury tiers, voting config
- **One-click Compilation** to 5 Solidity contracts
- **Generated Contracts** tab with per-contract view, syntax highlighting, copy, and download
- **Architecture View** showing contract dependency graph and OZ import map
- **Individual + bulk download** of generated .sol files

## Tech Stack

- **Compiler**: TypeScript (server-side, zero-dependency YAML parser for client)
- **Frontend**: Next.js 16, Tailwind CSS 4, shadcn/ui
- **Output**: Solidity ^0.8.20, OpenZeppelin Contracts v5.x
- **Protocol**: REST API (POST /api/compile)

## Project Structure

```
policyforge/
├── policy-types.ts          # Type definitions + example policy + OZ contract catalog
├── policy-compiler.ts       # YAML → Solidity compiler engine (663 lines)
├── route.ts                 # Next.js API route for compilation
├── screenshot-editor.png    # Policy editor view
├── screenshot-compiled.png  # Generated contracts view
├── screenshot-architecture.png  # Architecture view
└── README.md
```

## Impact

| Before PolicyForge | After PolicyForge |
|---|---|
| Days of Solidity wiring for governance | Minutes of YAML editing |
| Access control is the #1 smart contract vulnerability | Correct OZ AccessControl generated from policy |
| Every team wires OZ differently, often wrong | Standardized, auditable governance patterns |
| Governance config is tribal knowledge | Governance config is version-controlled code |
| "What quorum should we use?" → shrug | "4% quorum, 5-day voting, 48h timelock" → documented |

---

**Team**: Cubiczan · **Category**: Developer Tools
Built with [OpenZeppelin](https://github.com/openzeppelin/openzeppelin-contracts) Contracts — the industry standard for secure smart contract development.