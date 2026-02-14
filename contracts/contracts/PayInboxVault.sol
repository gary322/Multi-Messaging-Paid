// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract PayInboxVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    mapping(address => uint256) public balances;
    mapping(address => uint64) public nonces;

    uint16 public feeBps;
    address public feeRecipient;
    uint16 public constant MAX_FEE_BPS = 2_000;

    event MessagePaid(
        address indexed payer,
        address indexed recipient,
        bytes32 indexed messageId,
        uint256 amount,
        uint256 fee,
        bytes32 contentHash,
        uint64 nonce,
        uint32 channel
    );

    event Deposited(address indexed user, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed user, uint256 amount, uint256 newBalance);
    event FeeUpdated(uint16 feeBps, address indexed feeRecipient);
    event PausedAdmin(address account);
    event UnpausedAdmin(address account);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();
    error InvalidFee();

    constructor(address _token, uint16 _feeBps, address _feeRecipient) Ownable(msg.sender) {
        if (_token == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert InvalidFee();

        token = IERC20(_token);
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
    }

    function setFeeConfig(uint16 newFeeBps, address newFeeRecipient) external onlyOwner {
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee();
        feeBps = newFeeBps;
        feeRecipient = newFeeRecipient;
        emit FeeUpdated(newFeeBps, newFeeRecipient);
    }

    function pause() external onlyOwner {
        _pause();
        emit PausedAdmin(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit UnpausedAdmin(msg.sender);
    }

    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        balances[msg.sender] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, balances[msg.sender]);
    }

    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 current = balances[msg.sender];
        if (current < amount) revert InsufficientBalance();

        unchecked {
            balances[msg.sender] = current - amount;
        }

        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    function sendMessagePayment(
        address recipient,
        bytes32 messageId,
        bytes32 contentHash,
        uint32 channel,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint64 nonce = nonces[msg.sender] + 1;
        nonces[msg.sender] = nonce;

        uint256 fee = (amount * feeBps) / 10_000;
        uint256 total = amount + fee;

        uint256 payerBalance = balances[msg.sender];
        if (payerBalance < total) revert InsufficientBalance();

        unchecked {
            balances[msg.sender] = payerBalance - total;
            balances[recipient] += amount;
            balances[feeRecipient] += fee;
        }

        emit MessagePaid(
            msg.sender,
            recipient,
            messageId,
            amount,
            fee,
            contentHash,
            nonce,
            channel
        );
    }

    function balanceOf(address user) external view returns (uint256) {
        return balances[user];
    }
}
