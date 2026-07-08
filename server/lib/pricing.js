// pricing.js — Motor de Precificação Automática (markup divisor).
// Implementa a regra do documento BPM:
//   Custo_BRL              = CUSTO_USD * TAXA_CAMBIO_EFETIVA
//   Custo_Total_Importacao = Custo_BRL * (1 + IMPOSTO_IMPORTACAO)
//   Preco_de_Venda         = Custo_Total_Importacao / (1 - IMPOSTO_NF - MARGEM)
// Gera Preço Sugerido (margem alvo) e Preço Mínimo/Piso (margem mínima).
'use strict';

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/**
 * @param {object} p
 * @param {number} p.costUsd        custo do fabricante (USD)
 * @param {number} p.qty            quantidade (multiplica o custo)
 * @param {number} p.fxBase         taxa de mercado USD->BRL (sem spread)
 * @param {number} p.fxSpreadPct    spread cambial + IOF (ex.: 0.04)
 * @param {number} p.importTaxPct   impostos de importação (ex.: 0.15)
 * @param {number} p.invoiceTaxPct  impostos da NF de venda (ex.: 0.10)
 * @param {number} p.targetMarginPct margem alvo (ex.: 0.20)
 * @param {number} p.minMarginPct   margem mínima/piso (ex.: 0.10)
 */
function calculatePricing(p) {
  const qty = p.qty && p.qty > 0 ? p.qty : 1;
  const costUsd = Number(p.costUsd) * qty;
  const fxBase = Number(p.fxBase);
  const fxRate = fxBase * (1 + Number(p.fxSpreadPct || 0)); // taxa efetiva
  const importTax = Number(p.importTaxPct || 0);
  const invoiceTax = Number(p.invoiceTaxPct || 0);
  const targetMargin = Number(p.targetMarginPct || 0);
  const minMargin = Number(p.minMarginPct || 0);

  const costBrl = costUsd * fxRate;
  const costWithImport = costBrl * (1 + importTax);

  function priceForMargin(margin) {
    const divisor = 1 - invoiceTax - margin;
    if (divisor <= 0) return null; // configuração inválida (impostos+margem >= 100%)
    return costWithImport / divisor;
  }

  const suggested = priceForMargin(targetMargin);
  const min = priceForMargin(minMargin);

  return {
    costUsd: round2(costUsd),
    qty,
    fxBase: round2(fxBase),
    fxRate: round2(fxRate),
    importTaxPct: importTax,
    invoiceTaxPct: invoiceTax,
    targetMarginPct: targetMargin,
    minMarginPct: minMargin,
    costBrl: round2(costBrl),
    costWithImport: round2(costWithImport),
    suggestedPrice: suggested == null ? null : round2(suggested),
    minPrice: min == null ? null : round2(min),
    valid: suggested != null && min != null,
  };
}

module.exports = { calculatePricing, round2 };
