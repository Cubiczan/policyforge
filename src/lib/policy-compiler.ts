// eslint-disable-next-line @typescript-eslint/no-require-imports
const parseYaml = require("js-yaml").load;
import type {
  PolicyDocument,
  CompiledContract,
  CompilationResult,
  TreasuryLimit,
  RolePolicy,
} from "./policy-types";

function parseTimeToSeconds(time: string): string {
  const match = time.match(/^(\d+)\s*(second|minute|hour|day|week)s?$/i);
  if (!match) return "0";
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
  };
  return String(val * (multipliers[unit] || 1));
}

function parsePercentageToBasisPoints(pct: number): string {
  return String(Math.round(pct * 100)); // 4% → 400 basis points (out of 10000)
}

function parseMultisigRequirement(req: string): { total: number; required: number } | null {
  const match = req.match(/multisig_(\d+)_of_(\d+)/);
  if (!match) return null;
  return { required: parseInt(match[1]), total: parseInt(match[2]) };
}

function generateRoleConstants(roles: RolePolicy[]): string {
  return roles
    .map((r) => {
      const bytes32 = `bytes32 constant ${r.name.toUpperCase()}_ROLE = keccak256("${r.name}");`;
      return bytes32;
    })
    .join("\n    ");
}

function generateRoleSetup(roles: RolePolicy[]): string {
  const grants = roles
    .flatMap((r) =>
      r.members.map(
        (m) =>
          `        _grantRole(${r.name.toUpperCase()}_ROLE, ${m});`
      )
    )
    .join("\n");

  const adminRole = roles[0]; // first role is always admin
  return `    // Grant admin to deployer
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
${grants}
    // Role membership counts for multisig
${roles
  .filter((r) => r.members.length > 1)
  .map(
    (r) =>
      `    // ${r.name}: ${r.members.length} members (${r.members.map((m) => m.slice(0, 10)).join(", ")}...)`
  )
  .join("\n")}`;
}

function compileTreasuryContract(policy: PolicyDocument): CompiledContract {
  const { treasury, roles, timelock } = policy;
  const limits = treasury.limits;

  const tierFns = limits
    .map((limit: TreasuryLimit, i: number) => {
      const tierName = limit.currency === "unlimited" ? "unlimited" : `tier${i + 1}`;
      const amount = limit.currency === "unlimited" ? "type(uint256).max" : limit.amount;
      const timeLimit = parseTimeToSeconds(limit.period);
      const multisig = limit.requires.find((r: string) => r.startsWith("multisig_"));
      const needsTimelock = limit.requires.some((r: string) => r.startsWith("timelock_"));
      const needsVote = limit.requires.some((r: string) => r === "governance_vote");
      const sig = multisig ? parseMultisigRequirement(multisig) : null;

      let body = `    function _check${tierName.charAt(0).toUpperCase() + tierName.slice(1)}() internal view {
        // Tier ${i + 1}: Up to ${amount} ${limit.currency} per ${limit.period}
        uint256 amountLimit = ${amount} * 1e6;
        uint256 periodLimit = ${timeLimit};
${sig ? `        require(_countApprovals() >= ${sig.required}, "Treasury: insufficient approvals for tier ${i + 1}");` : "        // Single-signer authorized"}
${needsTimelock ? `        require(_timelockActive(), "Treasury: timelock required for this tier");` : ""}
${needsVote ? `        require(_governanceApproved(), "Treasury: governance vote required");` : ""}
    }`;

      return body;
    })
    .join("\n\n");

  return {
    name: "PolicyTreasury",
    imports: [
      "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol",
      "@openzeppelin/contracts/token/ERC20/IERC20.sol",
      "@openzeppelin/contracts/access/AccessControl.sol",
      "@openzeppelin/contracts/utils/ReentrancyGuard.sol",
    ],
    inherits: ["AccessControl", "ReentrancyGuard"],
    description: "Treasury contract with tiered approval thresholds derived from policy rules",
    solidity: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PolicyTreasury
 * @notice Auto-generated treasury contract from governance policy: "${policy.name} v${policy.version}"
 * @dev Enforces tiered transfer limits, timelock requirements, and multisig approvals
 *
 * Tier structure:
${limits.map((l: TreasuryLimit, i: number) => ` *   Tier ${i + 1}: Up to ${l.amount} ${l.currency} per ${l.period} — requires [${l.requires.join(", ")}]`).join("\n")}
 */
contract PolicyTreasury is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    IERC20 public immutable token;
    address public timelock;
    address public governor;

    struct TransferRecord {
        uint256 amount;
        uint256 timestamp;
        address to;
    }

    // Sliding window for rate limiting
    TransferRecord[] private _transfers;

    // Pausable state
    bool public paused;

    event TransferExecuted(address indexed to, uint256 amount, uint256 tier);
    event TreasuryPaused(address indexed by);
    event TreasuryUnpaused(address indexed by);

    error TreasuryPaused();
    error InsufficientApprovals(uint256 required, uint256 actual);
    error TimelockRequired();
    error ExceedsPeriodLimit(uint256 requested, uint256 limit);
    error UnauthorizedCaller();

    modifier whenNotPaused() {
        if (paused) revert TreasuryPaused();
        _;
    }

    modifier onlyTreasurerOrAdmin() {
        if (!hasRole(TREASURER_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender))
            revert UnauthorizedCaller();
        _;
    }

    constructor(
        address _token,
        address _timelock,
        address _governor
    ) {
        token = IERC20(_token);
        timelock = _timelock;
        governor = _governor;
${generateRoleSetup(policy.roles.filter((r) => ["admin", "treasurer", "guardian"].includes(r.name)))}
    }

${tierFns}

    function executeTransfer(
        address to,
        uint256 amount
    ) external onlyTreasurerOrAdmin whenNotPaused nonReentrant {
        // Determine tier
${limits.length > 0 ? limits.map((l: TreasuryLimit, i: number) => {
  const amountVal = l.currency === "unlimited" ? "type(uint256).max" : l.amount;
  return `        ${i > 0 ? "} else " : ""}if (amount <= ${amountVal} * 1e6) {
            _check${l.currency === "unlimited" ? "unlimited" : `tier${i + 1}`}();`;
}).join("\n") : ""}
        }

        // Check period limit
        uint256 periodLimit = _getPeriodLimit(amount);
        uint256 periodSpend = _getPeriodSpend(periodLimit);
        if (periodSpend + amount > periodLimit) {
            revert ExceedsPeriodLimit(amount, periodLimit - periodSpend);
        }

        // Execute
        token.safeTransfer(to, amount);
        _transfers.push(TransferRecord(amount, block.timestamp, to));

        emit TransferExecuted(to, amount, _getTier(amount));
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        paused = true;
        emit TreasuryPaused(msg.sender);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = false;
        emit TreasuryUnpaused(msg.sender);
    }

    function _getPeriodSpend(uint256 windowSeconds) internal view returns (uint256) {
        uint256 cutoff = block.timestamp - windowSeconds;
        uint256 total;
        for (uint256 i = _transfers.length; i > 0; i--) {
            if (_transfers[i - 1].timestamp < cutoff) break;
            total += _transfers[i - 1].amount;
        }
        return total;
    }

    function _getPeriodLimit(uint256 amount) internal pure returns (uint256) {
${limits.map((l: TreasuryLimit, i: number) => {
  const amountVal = l.currency === "unlimited" ? "type(uint256).max" : l.amount;
  const periodSec = parseTimeToSeconds(l.period);
  return `        if (amount <= ${amountVal} * 1e6) return ${periodSec};`;
}).join("\n")}
        return ${parseTimeToSeconds(limits[limits.length - 1]?.period || "24 hours")};
    }

    function _getTier(uint256 amount) internal pure returns (uint256) {
${limits.map((l: TreasuryLimit, i: number) => {
  const amountVal = l.currency === "unlimited" ? "type(uint256).max" : l.amount;
  return `        if (amount <= ${amountVal} * 1e6) return ${i + 1};`;
}).join("\n")}
        return ${limits.length};
    }

    function _countApprovals() internal view returns (uint256) {
        // In production, this checks a multisig signature count
        return 1; // placeholder — actual implementation uses your multisig of choice
    }

    function _timelockActive() internal view returns (bool) {
        return timelock != address(0);
    }

    function _governanceApproved() internal view returns (bool) {
        return governor != address(0);
    }
}`,
  };
}

function compileGovernorContract(policy: PolicyDocument): CompiledContract {
  const { proposals, roles, timelock, treasury } = policy;

  return {
    name: "PolicyGovernor",
    imports: [
      "@openzeppelin/contracts/governance/Governor.sol",
      "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol",
      "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol",
      "@openzeppelin/contracts/governance/compatibility/GovernorCompatibilityBravo.sol",
      "@openzeppelin/contracts/governance/utils/Votes.sol",
    ],
    inherits: [
      "Governor",
      "GovernorTimelockControl",
      "GovernorSettings",
      "GovernorCompatibilityBravo",
    ],
    description: "On-chain governance with configurable voting, quorum, and timelock execution",
    solidity: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/compatibility/GovernorCompatibilityBravo.sol";

/**
 * @title PolicyGovernor
 * @notice Auto-generated governor from policy: "${policy.name} v${policy.version}"
 * @dev Configured from governance-as-code policy document
 *
 * Configuration:
 *   Quorum: ${proposals.quorum_percentage}%
 *   Voting delay: ${proposals.voting_delay}
 *   Voting period: ${proposals.voting_period}
 *   Proposal threshold: ${proposals.proposal_threshold} tokens
 *   Delegation: ${proposals.allow_delegation ? "enabled" : "disabled"}
 *   Timelock: ${timelock.min_delay} min / ${timelock.max_delay} max
 */
contract PolicyGovernor is
    Governor,
    GovernorTimelockControl,
    GovernorSettings,
    GovernorCompatibilityBravo
{
    constructor(
        IVotes _token,
        TimelockController _timelock
    )
        Governor("PolicyGovernor")
        GovernorSettings(
            ${parseTimeToSeconds(proposals.voting_delay)},  // votingDelay
            ${parseTimeToSeconds(proposals.voting_period)},  // votingPeriod
            ${proposals.proposal_threshold}  // proposalThreshold
        )
        GovernorTimelockControl(_timelock)
    {}

    // Quorum from policy: ${proposals.quorum_percentage}%
    function quorum(uint256 blockNumber)
        public
        view
        override(IGovernor)
        returns (uint256)
    {
        return _token.getPastTotalSupply(blockNumber) * ${parsePercentageToBasisPoints(proposals.quorum_percentage)} / 10000;
    }

    // Voting weight: 1 token = 1 vote (from ERC20Votes checkpoint)
    function _getVotes(
        address account,
        uint256 blockNumber,
        bytes memory /*params*/
    ) internal view override(Governor) returns (uint256) {
        return _token.getPastVotes(account, blockNumber);
    }

    // State: count votes with quorum check
    function _countVote(
        uint256 proposalId,
        address account,
        uint8 support,
        uint256 totalWeight,
        bytes memory /*params*/
    ) internal pure override(Governor) returns (uint256) {
        return totalWeight;
    }

    // Proposal naming for explorer readability
    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    // Minimum timelock delay from policy
    function _timelockMinDelay() internal pure returns (uint256) {
        return ${parseTimeToSeconds(timelock.min_delay)};
    }
}`,
  };
}

function compileAccessControlContract(policy: PolicyDocument): CompiledContract {
  const { roles } = policy;

  const permissionChecks = roles
    .flatMap((r) =>
      r.permissions.map(
        (p) =>
          `    function require${p.replace(/_(.)/g, (_, c) => c.toUpperCase())}() external view {
        require(hasRole(${r.name.toUpperCase()}_ROLE, msg.sender), "${r.name}:${p} — access denied");
    }`
      )
    )
    .join("\n\n");

  return {
    name: "PolicyAccessControl",
    imports: [
      "@openzeppelin/contracts/access/AccessControl.sol",
    ],
    inherits: ["AccessControl"],
    description: "Role-based access control with hierarchical permissions derived from policy",
    solidity: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title PolicyAccessControl
 * @notice Auto-generated RBAC from policy: "${policy.name} v${policy.version}"
 * @dev Manages ${roles.length} roles with ${roles.reduce((a, r) => a + r.permissions.length, 0)} total permissions
 */
contract PolicyAccessControl is AccessControl {

${roles.map((r) => `    bytes32 public constant ${r.name.toUpperCase()}_ROLE = keccak256("${r.name}");`).join("\n")}

    event RoleMemberAdded(bytes32 indexed role, address indexed account);
    event RoleMemberRemoved(bytes32 indexed role, address indexed account);

${roles
  .map(
    (r) => `
    // ${r.description}
    // Members: ${r.members.length}
    // Permissions: ${r.permissions.join(", ")}`
  )
  .join("\n")}

    constructor() {
${generateRoleSetup(roles)}
    }

    // --- Permission check functions ---
${permissionChecks}

    // --- Admin role management ---
    function addMember(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(role, account);
        emit RoleMemberAdded(role, account);
    }

    function removeMember(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(role, account);
        emit RoleMemberRemoved(role, account);
    }

    // --- Batch operations ---
    function addMembers(bytes32 role, address[] calldata accounts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            grantRole(role, accounts[i]);
            emit RoleMemberAdded(role, accounts[i]);
        }
    }

    function removeMembers(bytes32 role, address[] calldata accounts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            revokeRole(role, accounts[i]);
            emit RoleMemberRemoved(role, accounts[i]);
        }
    }
}`,
  };
}

function compileTimelockContract(policy: PolicyDocument): CompiledContract {
  const { timelock, roles } = policy;
  const minDelay = parseTimeToSeconds(timelock.min_delay);
  const maxDelay = parseTimeToSeconds(timelock.max_delay);
  const proposers = roles
    .filter((r) => r.permissions.includes("propose_transfer") || r.permissions.includes("upgrade"))
    .map((r) => r.name.toUpperCase() + "_ROLE")
    .join(", ");
  const executors = roles
    .filter((r) => r.permissions.includes("execute") || r.permissions.includes("emergency_execute"))
    .map((r) => r.name.toUpperCase() + "_ROLE")
    .join(", ");

  return {
    name: "PolicyTimelock",
    imports: [
      "@openzeppelin/contracts/governance/TimelockController.sol",
    ],
    inherits: ["TimelockController"],
    description: "Timelock controller enforcing delayed execution with role-based bypass",
    solidity: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title PolicyTimelock
 * @notice Auto-generated timelock from policy: "${policy.name} v${policy.version}"
 * @dev Enforces ${timelock.min_delay} minimum delay before execution
 *
 * Min delay: ${timelock.min_delay} (${minDelay}s)
 * Max delay: ${timelock.max_delay} (${maxDelay}s)
 * Bypass roles: [${timelock.roles_can_bypass.join(", ")}]
 */
contract PolicyTimelock is TimelockController {

    uint256 public constant MIN_DELAY = ${minDelay};
    uint256 public constant MAX_DELAY = ${maxDelay};

    // Roles that can bypass the timelock
${timelock.roles_can_bypass.map((r) => `    bytes32 public constant ${r.toUpperCase()}_BYPASS = keccak256("${r}_bypass");`).join("\n")}

    constructor(
        uint256 _minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(_minDelay, proposers, executors, admin) {
        require(_minDelay >= MIN_DELAY, "Timelock: below minimum delay");
        require(_minDelay <= MAX_DELAY, "Timelock: exceeds maximum delay");
    }

    // Emergency execute — callable only by bypass roles
    function emergencyExecute(
        address target,
        uint256 value,
        bytes calldata data
    ) external {
${timelock.roles_can_bypass.map((r) => `        require(hasRole(${r.toUpperCase()}_BYPASS, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "${r} cannot bypass timelock");`).join("\n")}
        _execute(target, value, data);
    }
}`,
  };
}

function compileTokenContract(policy: PolicyDocument): CompiledContract {
  const { treasury, proposals } = policy;

  return {
    name: "PolicyToken",
    imports: [
      "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol",
      "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol",
    ],
    inherits: ["ERC20Votes", "ERC20Permit"],
    description: "Governance token with voting power, delegation, and permit (gasless approvals)",
    solidity: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title PolicyToken
 * @notice Auto-generated governance token from policy: "${policy.name} v${policy.version}"
 * @dev ERC20 with vote-weighted checkpoints and delegation support
 *
 * Used by PolicyGovernor for:
 *   - Proposal threshold: ${proposals.proposal_threshold} tokens
 *   - Quorum: ${proposals.quorum_percentage}% of total supply
 *   - Delegation: ${proposals.allow_delegation ? "enabled" : "disabled"}
 */
contract PolicyToken is ERC20Votes, ERC20Permit {
    constructor(
        string memory name_,
        string memory symbol_,
        address initialHolder,
        uint256 initialSupply
    ) ERC20(name_, symbol_) ERC20Permit(name_) Votes() {
        _mint(initialHolder, initialSupply);
    }

    // Override required by Solidity for multiple inheritance
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}`,
  };
}

export function compilePolicy(yaml: string): CompilationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ozContractsUsed: string[] = [];

  // Parse YAML
  let doc: any;
  try {
    doc = parseYaml(yaml) as PolicyDocument;
  } catch (e: any) {
    return {
      contracts: [],
      deployment_order: [],
      total_lines: 0,
      errors: [`YAML parse error: ${e.message}`],
      warnings: [],
      oz_contracts_used: [],
    };
  }

  // Validate required fields
  if (!doc.name) errors.push("Missing required field: name");
  if (!doc.version) errors.push("Missing required field: version");
  if (!doc.network) errors.push("Missing required field: network");
  if (!doc.roles || !Array.isArray(doc.roles) || doc.roles.length === 0)
    errors.push("At least one role must be defined");
  if (!doc.treasury || !doc.treasury.limits || doc.treasury.limits.length === 0)
    errors.push("At least one treasury limit tier must be defined");
  if (!doc.proposals) errors.push("Missing required section: proposals");

  if (errors.length > 0) {
    return { contracts: [], deployment_order: [], total_lines: 0, errors, warnings, oz_contracts_used: [] };
  }

  const policy = doc as unknown as PolicyDocument;

  // Warnings
  if (policy.treasury.limits.length === 1)
    warnings.push("Only one treasury tier defined — consider adding tiered limits for better security");
  if (policy.emergency?.pause_enabled && !policy.roles.some((r) => r.name === "guardian"))
    warnings.push("Emergency pause is enabled but no 'guardian' role is defined");
  if (policy.proposals.quorum_percentage < 1)
    warnings.push("Quorum percentage is less than 1% — proposals could pass with near-zero participation");
  if (policy.timelock.roles_can_bypass?.length > 0)
    warnings.push("Timelock bypass roles defined — ensure these are highly trusted");

  // Compile contracts
  const contracts: CompiledContract[] = [];
  const deployment_order: string[] = [];

  // 1. Access Control (no dependencies)
  const accessControl = compileAccessControlContract(policy);
  contracts.push(accessControl);
  deployment_order.push("PolicyAccessControl");
  ozContractsUsed.push("AccessControl");

  // 2. Timelock (no dependencies)
  if (policy.timelock) {
    const timelock = compileTimelockContract(policy);
    contracts.push(timelock);
    deployment_order.push("PolicyTimelock");
    ozContractsUsed.push("TimelockController");
  }

  // 3. Token (no dependencies)
  const token = compileTokenContract(policy);
  contracts.push(token);
  deployment_order.push("PolicyToken");
  ozContractsUsed.push("ERC20Votes", "ERC20Permit");

  // 4. Governor (depends on Token + Timelock)
  const governor = compileGovernorContract(policy);
  contracts.push(governor);
  deployment_order.push("PolicyGovernor");
  ozContractsUsed.push("Governor", "GovernorTimelockControl", "GovernorSettings", "GovernorCompatibilityBravo");

  // 5. Treasury (depends on Token + Timelock)
  if (policy.treasury?.enabled) {
    const treasury = compileTreasuryContract(policy);
    contracts.push(treasury);
    deployment_order.push("PolicyTreasury");
    ozContractsUsed.push("SafeERC20", "IERC20", "AccessControl", "ReentrancyGuard");
  }

  const total_lines = contracts.reduce((sum, c) => sum + c.solidity.split("\n").length, 0);

  return {
    contracts,
    deployment_order,
    total_lines,
    errors: [],
    warnings,
    oz_contracts_used: [...new Set(ozContractsUsed)],
  };
}