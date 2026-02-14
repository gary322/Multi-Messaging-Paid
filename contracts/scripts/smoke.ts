import { ethers } from 'hardhat';

const requiredError = (name: string) => {
  throw new Error(`Missing ${name}. Set ${name} as env var.`);
};

async function main() {
  const [deployer, sender, recipient] = await ethers.getSigners();

  const tokenAddress = process.env.USDC_ADDRESS ?? requiredError('USDC_ADDRESS');
  const vaultAddress = process.env.VAULT_ADDRESS ?? requiredError('VAULT_ADDRESS');
  const network = await ethers.provider.getNetwork();
  const topupAmount = process.env.TOPUP_AMOUNT ? BigInt(process.env.TOPUP_AMOUNT) : 1000n;
  const sendAmount = process.env.SEND_AMOUNT ? BigInt(process.env.SEND_AMOUNT) : 100n;
  const withdrawAmount = process.env.WITHDRAW_AMOUNT ? BigInt(process.env.WITHDRAW_AMOUNT) : 20n;

  const token = (await ethers.getContractAt('MockERC20', tokenAddress)) as any;
  const vault = (await ethers.getContractAt('PayInboxVault', vaultAddress)) as any;
  const decimals = BigInt(await token.decimals());

  const tenPowDecimals = 10n ** decimals;
  const topupAmountRaw = topupAmount * tenPowDecimals;
  const sendAmountRaw = sendAmount * tenPowDecimals;
  const withdrawAmountRaw = withdrawAmount * tenPowDecimals;

  await token.mint(sender.address, topupAmountRaw);
  await token.connect(sender).approve(vaultAddress, topupAmountRaw);
  await vault.connect(sender).deposit(topupAmountRaw);

  const senderVaultBalanceBefore = await vault.balanceOf(sender.address);
  const recipientVaultBalanceBefore = await vault.balanceOf(recipient.address);

  const tx = await vault
    .connect(sender)
    .sendMessagePayment(
      recipient.address,
      ethers.id('mmp-local-smoke'),
      ethers.id('mmp-payload-hash'),
      1,
      sendAmountRaw,
    );
  const receipt = await tx.wait();

  const senderVaultBalanceAfter = await vault.balanceOf(sender.address);
  const recipientVaultBalanceAfter = await vault.balanceOf(recipient.address);

  const recipientTokenBefore = await token.balanceOf(recipient.address);
  await vault.connect(recipient).withdraw(withdrawAmountRaw);
  const recipientTokenAfter = await token.balanceOf(recipient.address);
  const recipientVaultBalanceAfterWithdraw = await vault.balanceOf(recipient.address);

  const messagePaidEvents = await vault.queryFilter(
    vault.filters.MessagePaid(
      sender.address,
      recipient.address,
      ethers.id('mmp-local-smoke'),
    ),
  );

  console.log(
    JSON.stringify(
      {
        chainId: Number(network.chainId),
        deployer: deployer.address,
        sender: sender.address,
        recipient: recipient.address,
        tokenAddress,
        vaultAddress,
        receiptHash: receipt?.hash ?? '',
        senderVaultBalanceBefore: senderVaultBalanceBefore.toString(),
        senderVaultBalanceAfter: senderVaultBalanceAfter.toString(),
        recipientVaultBalanceBefore: recipientVaultBalanceBefore.toString(),
        recipientVaultBalanceAfter: recipientVaultBalanceAfter.toString(),
        recipientTokenBefore: recipientTokenBefore.toString(),
        recipientTokenAfter: recipientTokenAfter.toString(),
        recipientVaultBalanceAfterWithdraw: recipientVaultBalanceAfterWithdraw.toString(),
        topupAmountRaw: topupAmountRaw.toString(),
        sendAmountRaw: sendAmountRaw.toString(),
        withdrawAmountRaw: withdrawAmountRaw.toString(),
        messagePaidEvents: messagePaidEvents.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
