import { expect } from "chai";
import { ethers } from "hardhat";

describe("PayInboxVault", function () {
  let token: any;
  let vault: any;
  let owner: any;
  let alice: any;
  let bob: any;

  beforeEach(async () => {
    const accounts = await ethers.getSigners();
    owner = accounts[0];
    alice = accounts[1];
    bob = accounts[2];

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Test USDC", "TUSDC", 6);
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("PayInboxVault");
    vault = await Vault.deploy(await token.getAddress(), 250, owner.address);
    await vault.waitForDeployment();

    await token.mint(alice.address, 1_000_000n);
    await token.connect(alice).approve(await vault.getAddress(), 1_000_000n);
    await vault.connect(alice).deposit(500_000n);
  });

  it("deposits and withdraws", async () => {
    expect(await vault.balanceOf(alice.address)).to.equal(500_000n);
    await vault.connect(alice).withdraw(200_000n);
    expect(await vault.balanceOf(alice.address)).to.equal(300_000n);
    expect(await token.balanceOf(alice.address)).to.equal(700_000n);
  });

  it("sends paid message and charges fee", async () => {
    await vault.connect(alice).sendMessagePayment(
      bob.address,
      ethers.id("msg-1"),
      ethers.id("content-1"),
      1,
      100_000n
    );

    expect(await vault.balanceOf(alice.address)).to.equal(500_000n - 100_000n - 2_500n);
    expect(await vault.balanceOf(bob.address)).to.equal(100_000n);
    expect(await vault.balanceOf(owner.address)).to.equal(2_500n);

    const events = await vault.queryFilter(vault.filters.MessagePaid(alice.address, null, null));
    expect(events).to.have.length(1);
    expect(events[0].args.messageId).to.equal(ethers.id("msg-1"));
  });

  it("fails on insufficient balance", async () => {
    await expect(
      vault.connect(alice).sendMessagePayment(
        bob.address,
        ethers.id("msg-2"),
        ethers.id("content-2"),
        1,
        1_000_000n
      )
    ).to.be.revertedWithCustomError(vault, "InsufficientBalance");
  });

  it("supports pause", async () => {
    await vault.pause();
    await expect(vault.connect(alice).withdraw(1n)).to.be.reverted;
  });
});

describe("PricingRegistry", function () {
  it("stores and updates pricing", async () => {
    const Pricing = (await ethers.getContractFactory("PricingRegistry")) as any;
    const registry = await Pricing.deploy();
    await registry.waitForDeployment();

    const [owner] = await ethers.getSigners();
    await (registry.connect(owner) as any).setPricing(100n, 250n, 1000, true, false);
    const p = await registry.pricing(owner.address);
    expect(p.defaultPrice).to.equal(100n);
    expect(p.firstContactPrice).to.equal(250n);
    expect(p.returnDiscountBps).to.equal(1000);
  });
});
