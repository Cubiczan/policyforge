// Policy-as-Code types for the governance engine

export interface PolicyDocument {
  name: string;
  version: string;
  network: string;
  description: string;
  treasury: TreasuryPolicy;
  roles: RolePolicy[];
  proposals: ProposalPolicy;
  timelock: TimelockPolicy;
  emergency: EmergencyPolicy;
}

export interface TreasuryPolicy {
  enabled: boolean;
  token_address?: string;
  limits: TreasuryLimit[];
}

export interface TreasuryLimit {
  amount: string;
  currency: string;
  period: string;
  requires: string[]; // e.g. ["timelock", "multisig_3_of_5"]
  allow_single_signer: boolean;
}

export interface RolePolicy {
  name: string;
  description: string;
  members: string[];
  permissions: string[];
}

export interface ProposalPolicy {
  quorum_percentage: number;
  voting_delay: string;
  voting_period: string;
  proposal_threshold: string;
  allow_delegation: boolean;
}

export interface TimelockPolicy {
  min_delay: string;
  max_delay: string;
  roles_can_bypass: string[];
}

export interface EmergencyPolicy {
  pause_enabled: boolean;
  pause_role: string;
  guardian_address?: string;
  auto_unpause: string;
}

export interface CompiledContract {
  name: string;
  solidity: string;
  imports: string[];
  inherits: string[];
  description: string;
}

export interface CompilationResult {
  contracts: CompiledContract[];
  deployment_order: string[];
  total_lines: number;
  errors: string[];
  warnings: string[];
  oz_contracts_used: string[];
}

export const EXAMPLE_POLICY: string = `# Governance Policy — DAO Treasury v1
# Define on-chain governance rules as code

name: "DAO Treasury"
version: "1.0.0"
network: "ethereum"
description: "Governance policy for multi-sig treasury management with tiered approval thresholds"

treasury:
  enabled: true
  token_address: "0x"
  limits:
    - amount: "10000"
      currency: "USDC"
      period: "24h"
      requires: ["multisig_1_of_3"]
      allow_single_signer: true
    - amount: "100000"
      currency: "USDC"
      period: "24h"
      requires: ["timelock_48h", "multisig_3_of_5"]
      allow_single_signer: false
    - amount: "unlimited"
      currency: "USDC"
      period: "24h"
      requires: ["governance_vote", "timelock_72h"]
      allow_single_signer: false

roles:
  - name: "admin"
    description: "Full administration rights"
    members: ["0xAdmin1...", "0xAdmin2..."]
    permissions: ["pause", "unpause", "upgrade", "add_role", "remove_role"]
  - name: "treasurer"
    description: "Treasury operations up to tier-1 limits"
    members: ["0xTreasurer1...", "0xTreasurer2...", "0xTreasurer3..."]
    permissions: ["transfer_below_limit", "propose_transfer"]
  - name: "guardian"
    description: "Emergency pause authority"
    members: ["0xGuardian..."]
    permissions: ["pause", "emergency_execute"]
  - name: "auditor"
    description: "Read-only access to all governance state"
    members: ["0xAuditor..."]
    permissions: ["view_proposals", "view_treasury", "view_roles"]

proposals:
  quorum_percentage: 4
  voting_delay: "1 day"
  voting_period: "5 days"
  proposal_threshold: "1000"
  allow_delegation: true

timelock:
  min_delay: "12 hours"
  max_delay: "30 days"
  roles_can_bypass: ["admin"]

emergency:
  pause_enabled: true
  pause_role: "guardian"
  guardian_address: "0xGuardian..."
  auto_unpause: "72 hours"
`;

export const OZ_CONTRACTS = {
  Governor: {
    name: "OpenZeppelin Governor",
    description: "On-chain proposal creation, voting, and execution with flexible voting strategies",
    category: "Governance",
  },
  GovernorCountingSimple: {
    name: "Simple Counting Module",
    description: "1-token-1-vote counting with quorum requirements",
    category: "Governance",
  },
  GovernorTimelockControl: {
    name: "Timelock Controller Integration",
    description: "Binds governor execution to a Timelock for delayed enactment",
    category: "Governance",
  },
  TimelockController: {
    name: "Timelock Controller",
    description: "Enforces minimum delay before executing sensitive operations",
    category: "Security",
  },
  AccessControl: {
    name: "Role-Based Access Control",
    description: "Granular permission system with hierarchical roles",
    category: "Security",
  },
  ERC20Votes: {
    name: "ERC20 with Voting Power",
    description: "Vote-weighted token with delegation support and checkpointing",
    category: "Tokens",
  },
  ERC20Pausable: {
    name: "Pausable ERC20",
    description: "Token with emergency pause/resume capability",
    category: "Tokens",
  },
  SafeERC20: {
    name: "Safe ERC20 Transfers",
    description: "Wrapper around ERC20 operations that checks for return values",
    category: "Tokens",
  },
  Multicall: {
    name: "Multicall",
    description: "Batch multiple calls into a single transaction",
    category: "Utility",
  },
  ReentrancyGuard: {
    name: "Reentrancy Guard",
    description: "Prevents reentrancy attacks on critical functions",
    category: "Security",
  },
} as const;

export type OZContractKey = keyof typeof OZ_CONTRACTS;