const db = require("./firebase");
const { sendTON } = require("./ton");

const withdrawalsRef = db.ref("withdrawals");

withdrawalsRef.on("child_added", async (snapshot) => {

  const withdrawId = snapshot.key;
  const data = snapshot.val();

  if (!data || data.status !== "pending") return;

  try {

    console.log("Processing:", withdrawId);

    // 1️⃣ قفل العملية فوراً
    await withdrawalsRef.child(withdrawId).update({
      status: "processing",
      updatedAt: Date.now()
    });

    // 2️⃣ تحقق من البيانات
    if (!data.address || !data.netAmount || data.netAmount <= 0) {
      throw new Error("Invalid withdrawal data");
    }

    // 3️⃣ إرسال TON
    const txHash = await sendTON(data.address, data.netAmount);

    // 4️⃣ تحديث بعد النجاح
    await withdrawalsRef.child(withdrawId).update({
      status: "paid",
      txHash: txHash,
      updatedAt: Date.now()
    });

    console.log("Paid:", withdrawId);

  } catch (error) {

    console.log("Error:", error);

    await withdrawalsRef.child(withdrawId).update({
      status: "failed",
      error: error.message,
      updatedAt: Date.now()
    });

  }

});
