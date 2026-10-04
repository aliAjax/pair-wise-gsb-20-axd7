import { describe, expect, it } from "vitest";
import { runSelfChecks } from "../src/selfcheck";
import { buildDemoWorld } from "../src/seed";

describe("视野拼接与测量复核规则", () => {
  for (const check of runSelfChecks()) {
    it(check.name, () => {
      expect(check.pass, check.detail).toBe(true);
    });
  }
});

describe("演示场景", () => {
  it("覆盖：绑定批次/重叠合并/确认锁定/标定重算/中断恢复/待核旧记录", () => {
    const w = buildDemoWorld();
    const b1 = w.batches[0];
    // 批次1 已完成，结构数=规划数（重叠单编号）
    expect(b1.status).toBe("已完成");
    const b1Structures = w.structures.filter((s) => s.batchId === b1.id);
    expect(b1Structures.length).toBe(8);
    expect(b1Structures.filter((s) => s.overlap).length).toBe(4);
    // 一个已确认件锁定 40x-v1，且检测到 40x-v2 提示
    const locked = b1Structures.find((s) => s.measurement.state === "已确认")!;
    expect(locked.measurement.confirmed?.calLabel).toBe("40x-v1");
    expect(locked.measurement.currentCalId).toBeTruthy();
    expect(locked.observations.some((o) => o.afterLock)).toBe(true);
    // 未确认件已按 v2 重算
    const recalced = b1Structures.filter((s) => s.measurement.recalculatedFromCalId);
    expect(recalced.length).toBe(7);
    expect(recalced.every((s) => s.measurement.calId !== s.measurement.recalculatedFromCalId)).toBe(true);
    // 批次2 中断待恢复，只导入 1/2
    const b2 = w.batches[1];
    expect(b2.status).toBe("已中断");
    expect(b2.importedKeys.length).toBe(1);
    // 旧记录：2 待核 + 1 已补录
    const legacy = w.structures.filter((s) => s.legacy);
    expect(legacy.length).toBe(3);
    expect(legacy.filter((s) => s.measurement.state === "待核").length).toBe(2);
    expect(legacy.find((s) => s.measurement.state === "待测量")).toBeTruthy();
    // 100x 结构不被 40x-v2 波及
    const b2Structures = w.structures.filter((s) => s.batchId === b2.id);
    expect(b2Structures.every((s) => !s.measurement.recalculatedFromCalId)).toBe(true);
  });
});
