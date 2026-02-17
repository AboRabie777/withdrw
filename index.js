import { mnemonicToPrivateKey } from "ton-crypto";

async function run() {
  const seed = process.env.TON_SEED;

  if (!seed) {
    console.log("No TON_SEED found");
    return;
  }

  const mnemonic = seed.split(" ");
  const keyPair = await mnemonicToPrivateKey(mnemonic);

  console.log("====== RESULT ======");
  console.log("Private Key (HEX):");
  console.log(Buffer.from(keyPair.secretKey).toString("hex"));
  console.log("====================");
}

run();
