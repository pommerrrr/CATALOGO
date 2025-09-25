// src/lib/calculations.ts
export type CalcInput = {
  unitUsd: number;
  qty: number;
  freightUsd: number;
  usdbrl: number;
  icmsInside: boolean;
  faturPct: number;
  commissionPct: number;
  mlPrice: number;
  shippingMlBrl: number;
};

export type CalcOutput = {
  cifBrl: number;
  ii: number;
  icms: number;
  impostos: number;
  custoUnitBrl: number;
  comissao: number;
  impFatur: number;
  margemBrl: number;
  margemPct: number;
};

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeCosts(i: CalcInput): CalcOutput {
  const cifBrl = (i.unitUsd * i.qty + i.freightUsd) * i.usdbrl;
  const ii = 0.60 * cifBrl;

  const icmsBase = cifBrl + ii;
  const icms = i.icmsInside
    ? (icmsBase * 0.17) / (1 - 0.17)
    : icmsBase * 0.17;

  const impostos = ii + icms;
  const custoTotalBrl = cifBrl + impostos;
  const custoUnitBrl = custoTotalBrl / (i.qty || 1);

  const comissao = (i.commissionPct / 100) * (i.mlPrice || 0);
  const impFatur = (i.faturPct / 100) * (i.mlPrice || 0);

  const margemBrl =
    (i.mlPrice || 0) - (custoUnitBrl + comissao + impFatur + (i.shippingMlBrl || 0));

  const margemPct = i.mlPrice ? (margemBrl / i.mlPrice) * 100 : 0;

  return {
    cifBrl: round2(cifBrl),
    ii: round2(ii),
    icms: round2(icms),
    impostos: round2(impostos),
    custoUnitBrl: round2(custoUnitBrl),
    comissao: round2(comissao),
    impFatur: round2(impFatur),
    margemBrl: round2(margemBrl),
    margemPct: round2(margemPct),
  };
}
