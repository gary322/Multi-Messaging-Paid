// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract PricingRegistry is Ownable {
    struct Pricing {
        uint256 defaultPrice;
        uint256 firstContactPrice;
        uint256 returnDiscountBps;
        bool hasFirstContactDiscount;
        bool acceptsAll;
        string profileURI;
    }

    struct AllowlistEntry {
        uint16 discountBps;
        bool enabled;
    }

    mapping(address => Pricing) public pricing;
    mapping(address => mapping(address => AllowlistEntry)) public allowlist;
    uint16 public constant MAX_BPS = 10_000;

    event PricingUpdated(address indexed user, uint256 defaultPrice, uint256 firstContactPrice, uint16 returnDiscountBps, bool hasFirstContactDiscount);
    event AllowlistUpdated(address indexed user, address indexed sender, uint16 discountBps, bool enabled);
    event ProfileUpdated(address indexed user, string profileURI);

    error InvalidBps();

    constructor() Ownable(msg.sender) {}

    function setPricing(
        uint256 defaultPrice,
        uint256 firstContactPrice,
        uint16 returnDiscountBps,
        bool hasFirstContactDiscount,
        bool acceptsAll
    ) external {
        if (returnDiscountBps > MAX_BPS) revert InvalidBps();

        pricing[msg.sender] = Pricing({
            defaultPrice: defaultPrice,
            firstContactPrice: firstContactPrice,
            returnDiscountBps: returnDiscountBps,
            hasFirstContactDiscount: hasFirstContactDiscount,
            acceptsAll: acceptsAll,
            profileURI: pricing[msg.sender].profileURI
        });

        emit PricingUpdated(msg.sender, defaultPrice, firstContactPrice, returnDiscountBps, hasFirstContactDiscount);
    }

    function setProfileURI(string calldata profileURI) external {
        pricing[msg.sender].profileURI = profileURI;
        emit ProfileUpdated(msg.sender, profileURI);
    }

    function setAllowlist(address sender, uint16 discountBps, bool enabled) external {
        if (discountBps > MAX_BPS) revert InvalidBps();
        allowlist[msg.sender][sender] = AllowlistEntry({
            discountBps: discountBps,
            enabled: enabled
        });
        emit AllowlistUpdated(msg.sender, sender, discountBps, enabled);
    }
}
