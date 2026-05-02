-- CreateTable
CREATE TABLE "kitchen_equipment" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "pots" JSONB NOT NULL DEFAULT '[]',
    "gas_burners" INTEGER NOT NULL DEFAULT 0,
    "induction_burners" INTEGER NOT NULL DEFAULT 0,
    "big_burner_threshold" INTEGER NOT NULL DEFAULT 80,

    CONSTRAINT "kitchen_equipment_pkey" PRIMARY KEY ("id")
);
