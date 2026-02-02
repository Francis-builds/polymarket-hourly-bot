#!/usr/bin/env python3
"""
Análisis matemático: Estrategia A (Dip Simple) vs Estrategia B (2-Leg)
Polymarket 15-min crypto markets arbitrage
"""

import numpy as np
import matplotlib.pyplot as plt
from dataclasses import dataclass
from typing import List, Tuple
import pandas as pd

@dataclass
class StrategyMetrics:
    """Métricas de rendimiento de una estrategia"""
    name: str
    expected_value: float
    variance: float
    sharpe_ratio: float
    max_drawdown: float
    win_rate: float
    avg_profit_per_trade: float
    total_profit: float
    opportunities_per_day: float

class StrategyAnalyzer:
    """Analizador matemático de estrategias de arbitraje"""

    def __init__(self, initial_capital: float = 1000):
        self.initial_capital = initial_capital

    def strategy_a_ev(self, entry_threshold: float = 0.96, fee_rate: float = 0.03) -> dict:
        """
        Estrategia A: Dip Simple

        Fórmulas:
        - Costo de entrada: C = P_up + P_down (donde C < threshold)
        - Payout: $1.00 (siempre)
        - Gross profit: $1.00 - C
        - Fees: fee_rate * (P_up + P_down) = fee_rate * C
        - Net profit: $1.00 - C - (fee_rate * C) = $1.00 - C(1 + fee_rate)

        Expected Value:
        EV = P(win) * E[profit | win] + P(loss) * E[loss | loss]
        EV = 1.0 * E[profit] + 0 * 0
        """
        # Asumiendo entrada promedio en $0.95 (threshold $0.96)
        avg_entry_cost = 0.95

        # Payout garantizado
        payout = 1.00

        # Gross profit
        gross_profit = payout - avg_entry_cost

        # Fees (3% sobre cada compra)
        # Si compramos UP a $0.475 y DOWN a $0.475, fees = 0.03 * 0.95
        total_fees = fee_rate * avg_entry_cost

        # Net profit
        net_profit = gross_profit - total_fees

        # Profit percentage
        profit_pct = (net_profit / avg_entry_cost) * 100

        # Expected Value (100% win rate)
        ev = 1.0 * net_profit

        # Variance (sin varianza porque es determinístico)
        variance = 0
        std_dev = 0

        return {
            'avg_entry_cost': avg_entry_cost,
            'gross_profit': gross_profit,
            'total_fees': total_fees,
            'net_profit': net_profit,
            'profit_pct': profit_pct,
            'ev': ev,
            'variance': variance,
            'std_dev': std_dev,
            'win_rate': 1.0
        }

    def strategy_b_ev(self,
                      leg1_drop: float = 0.15,
                      leg2_threshold: float = 0.95,
                      fee_rate: float = 0.03,
                      leg2_execution_prob: float = 0.50) -> dict:
        """
        Estrategia B: 2-Leg

        Fórmulas:
        - Leg 1: Comprar lado que cae 15%+ (típicamente ~$0.35-0.40)
        - Leg 2: Comprar lado opuesto cuando leg1Price + oppositeAsk < threshold

        Escenarios:
        1. Ambos legs ejecutan (prob = leg2_execution_prob):
           - Costo total: leg1_price + leg2_price < 0.95
           - Payout: $1.00
           - Net profit: $1.00 - total_cost - fees

        2. Solo Leg 1 ejecuta (prob = 1 - leg2_execution_prob):
           - Si Leg 1 gana (prob = leg1_price): profit = $1.00 - leg1_price - fees
           - Si Leg 1 pierde (prob = 1 - leg1_price): loss = -leg1_price - fees

        Expected Value:
        EV = P(both_legs) * E[profit | both] + P(leg1_only) * E[profit | leg1_only]
        """
        # Leg 1: precio típico después de caída 15%
        leg1_price = 0.38  # Típicamente entre $0.35-0.40

        # Leg 2: precio para completar arbitraje
        leg2_price = leg2_threshold - leg1_price  # ~$0.57 si threshold es $0.95

        # Escenario 1: Ambos legs ejecutan
        prob_both_legs = leg2_execution_prob
        total_cost_both = leg1_price + leg2_price
        fees_both = fee_rate * total_cost_both
        net_profit_both = 1.00 - total_cost_both - fees_both

        # Escenario 2: Solo Leg 1 ejecuta
        prob_leg1_only = 1 - leg2_execution_prob
        fees_leg1 = fee_rate * leg1_price

        # Sub-escenario 2a: Leg 1 gana (probabilidad = precio implícito)
        prob_leg1_wins = leg1_price  # Precio = probabilidad implícita
        profit_leg1_wins = 1.00 - leg1_price - fees_leg1

        # Sub-escenario 2b: Leg 1 pierde
        prob_leg1_loses = 1 - leg1_price
        loss_leg1_loses = -leg1_price - fees_leg1

        # Expected value de solo Leg 1
        ev_leg1_only = (prob_leg1_wins * profit_leg1_wins +
                        prob_leg1_loses * loss_leg1_loses)

        # Expected Value total
        ev_total = (prob_both_legs * net_profit_both +
                    prob_leg1_only * ev_leg1_only)

        # Variance calculation
        # Var(X) = E[X^2] - (E[X])^2
        ev_squared_both = prob_both_legs * (net_profit_both ** 2)
        ev_squared_leg1_wins = prob_leg1_only * prob_leg1_wins * (profit_leg1_wins ** 2)
        ev_squared_leg1_loses = prob_leg1_only * prob_leg1_loses * (loss_leg1_loses ** 2)

        e_x_squared = ev_squared_both + ev_squared_leg1_wins + ev_squared_leg1_loses
        variance = e_x_squared - (ev_total ** 2)
        std_dev = np.sqrt(variance)

        # Win rate
        win_rate = prob_both_legs + prob_leg1_only * prob_leg1_wins

        # Average profit per winning trade
        avg_profit_wins = (prob_both_legs * net_profit_both +
                          prob_leg1_only * prob_leg1_wins * profit_leg1_wins) / win_rate if win_rate > 0 else 0

        return {
            'leg1_price': leg1_price,
            'leg2_price': leg2_price,
            'prob_both_legs': prob_both_legs,
            'net_profit_both': net_profit_both,
            'ev_leg1_only': ev_leg1_only,
            'ev_total': ev_total,
            'variance': variance,
            'std_dev': std_dev,
            'win_rate': win_rate,
            'avg_profit_wins': avg_profit_wins,
            'max_loss': loss_leg1_loses
        }

    def find_breakeven_leg2_prob(self, strategy_a_ev: float) -> float:
        """
        Encuentra la probabilidad de ejecución de Leg 2 donde EV(B) = EV(A)

        Resuelve: EV_B(p) = EV_A
        donde p = leg2_execution_prob
        """
        # Búsqueda binaria para encontrar breakeven
        low, high = 0.0, 1.0
        tolerance = 0.0001

        while high - low > tolerance:
            mid = (low + high) / 2
            ev_b = self.strategy_b_ev(leg2_execution_prob=mid)['ev_total']

            if ev_b < strategy_a_ev:
                low = mid
            else:
                high = mid

        return (low + high) / 2

    def monte_carlo_simulation(self,
                               strategy: str,
                               n_trades: int = 1000,
                               n_simulations: int = 1000,
                               **kwargs) -> dict:
        """
        Simulación Monte Carlo de N trades

        Returns:
            - profit_distribution: distribución de profit total
            - max_drawdown_distribution: distribución de máximo drawdown
            - sharpe_ratio: Sharpe ratio promedio
        """
        results = []
        max_drawdowns = []

        for _ in range(n_simulations):
            capital = self.initial_capital
            peak_capital = capital
            max_dd = 0
            equity_curve = [capital]

            for trade in range(n_trades):
                if strategy == 'A':
                    # Estrategia A: profit determinístico
                    metrics = self.strategy_a_ev(**kwargs)
                    profit = metrics['net_profit']

                elif strategy == 'B':
                    # Estrategia B: profit estocástico
                    metrics = self.strategy_b_ev(**kwargs)

                    # Determinar resultado
                    rand = np.random.random()

                    if rand < metrics['prob_both_legs']:
                        # Ambos legs ejecutan
                        profit = metrics['net_profit_both']
                    else:
                        # Solo Leg 1
                        if np.random.random() < metrics['leg1_price']:
                            # Leg 1 gana
                            profit = 1.00 - metrics['leg1_price'] - 0.03 * metrics['leg1_price']
                        else:
                            # Leg 1 pierde
                            profit = -metrics['leg1_price'] - 0.03 * metrics['leg1_price']

                capital += profit
                equity_curve.append(capital)

                # Track drawdown
                if capital > peak_capital:
                    peak_capital = capital
                current_dd = (peak_capital - capital) / peak_capital
                max_dd = max(max_dd, current_dd)

            total_profit = capital - self.initial_capital
            results.append(total_profit)
            max_drawdowns.append(max_dd)

        results = np.array(results)
        max_drawdowns = np.array(max_drawdowns)

        # Calcular Sharpe Ratio
        # Sharpe = E[R] / σ(R)
        # Asumiendo risk-free rate = 0
        mean_return = np.mean(results) / self.initial_capital
        std_return = np.std(results) / self.initial_capital
        sharpe = mean_return / std_return if std_return > 0 else 0

        return {
            'mean_profit': np.mean(results),
            'median_profit': np.median(results),
            'std_profit': np.std(results),
            'min_profit': np.min(results),
            'max_profit': np.max(results),
            'profit_distribution': results,
            'mean_max_drawdown': np.mean(max_drawdowns),
            'worst_drawdown': np.max(max_drawdowns),
            'sharpe_ratio': sharpe,
            'prob_profit': np.sum(results > 0) / len(results)
        }

    def frequency_analysis(self,
                          strategy_a_opportunities_per_day: float = 20,
                          strategy_b_opportunities_per_day: float = 5) -> dict:
        """
        Análisis de frecuencia de oportunidades

        Profit diario = Opportunities * EV_per_trade
        """
        ev_a = self.strategy_a_ev()['ev']
        ev_b = self.strategy_b_ev(leg2_execution_prob=0.50)['ev_total']

        daily_profit_a = strategy_a_opportunities_per_day * ev_a
        daily_profit_b = strategy_b_opportunities_per_day * ev_b

        monthly_profit_a = daily_profit_a * 30
        monthly_profit_b = daily_profit_b * 30

        return {
            'strategy_a': {
                'opportunities_per_day': strategy_a_opportunities_per_day,
                'ev_per_trade': ev_a,
                'daily_profit': daily_profit_a,
                'monthly_profit': monthly_profit_a
            },
            'strategy_b': {
                'opportunities_per_day': strategy_b_opportunities_per_day,
                'ev_per_trade': ev_b,
                'daily_profit': daily_profit_b,
                'monthly_profit': monthly_profit_b
            }
        }


def main():
    """Ejecutar análisis completo"""
    print("=" * 80)
    print("ANÁLISIS MATEMÁTICO: ESTRATEGIA A vs ESTRATEGIA B")
    print("Polymarket 15-min Crypto Markets Arbitrage")
    print("=" * 80)
    print()

    analyzer = StrategyAnalyzer(initial_capital=1000)

    # ============================================================================
    # 1. EXPECTED VALUE ANALYSIS
    # ============================================================================
    print("1. EXPECTED VALUE (EV) ANALYSIS")
    print("-" * 80)

    ev_a = analyzer.strategy_a_ev()
    print("\n📊 ESTRATEGIA A (Dip Simple):")
    print(f"   Entry cost promedio: ${ev_a['avg_entry_cost']:.3f}")
    print(f"   Gross profit: ${ev_a['gross_profit']:.3f}")
    print(f"   Fees (3%): ${ev_a['total_fees']:.4f}")
    print(f"   Net profit: ${ev_a['net_profit']:.4f} ({ev_a['profit_pct']:.2f}%)")
    print(f"   Expected Value: ${ev_a['ev']:.4f}")
    print(f"   Win rate: {ev_a['win_rate']*100:.1f}%")
    print(f"   Variance: {ev_a['variance']:.6f} (determinístico)")

    # Probar diferentes probabilidades de Leg 2
    leg2_probs = [0.30, 0.40, 0.50, 0.60, 0.70]

    print("\n📊 ESTRATEGIA B (2-Leg) - Diferentes probabilidades Leg 2:")
    print()

    for prob in leg2_probs:
        ev_b = analyzer.strategy_b_ev(leg2_execution_prob=prob)
        print(f"   P(Leg 2 ejecuta) = {prob:.0%}:")
        print(f"      EV total: ${ev_b['ev_total']:.4f}")
        print(f"      Win rate: {ev_b['win_rate']*100:.1f}%")
        print(f"      Std dev: ${ev_b['std_dev']:.4f}")
        print(f"      Max loss: ${ev_b['max_loss']:.4f}")
        print()

    # Breakeven analysis
    print("\n🎯 BREAKEVEN ANALYSIS:")
    breakeven_prob = analyzer.find_breakeven_leg2_prob(ev_a['ev'])
    print(f"   Probabilidad de Leg 2 para EV(B) = EV(A): {breakeven_prob:.2%}")
    print(f"   Si P(Leg 2) > {breakeven_prob:.2%}, Estrategia B es mejor")
    print(f"   Si P(Leg 2) < {breakeven_prob:.2%}, Estrategia A es mejor")

    # ============================================================================
    # 2. VARIANZA Y RIESGO DE RUINA
    # ============================================================================
    print("\n" + "=" * 80)
    print("2. VARIANZA Y DRAWDOWN ANALYSIS")
    print("-" * 80)

    print("\n📉 RIESGO DE RUINA (Capital inicial: $1,000):")
    print()

    # Estrategia A
    print("   ESTRATEGIA A:")
    print(f"      Varianza: {ev_a['variance']:.6f}")
    print(f"      Std dev: ${ev_a['std_dev']:.4f}")
    print(f"      Peor escenario: $0 (sin pérdidas, solo oportunidad perdida)")
    print(f"      Riesgo de ruina: 0% (sin pérdidas posibles)")
    print()

    # Estrategia B
    ev_b_50 = analyzer.strategy_b_ev(leg2_execution_prob=0.50)
    print("   ESTRATEGIA B (P(Leg 2) = 50%):")
    print(f"      Varianza: {ev_b_50['variance']:.6f}")
    print(f"      Std dev: ${ev_b_50['std_dev']:.4f}")
    print(f"      Max loss por trade: ${ev_b_50['max_loss']:.4f}")

    # Calcular trades hasta ruina
    max_consecutive_losses = int(1000 / abs(ev_b_50['max_loss']))
    prob_consecutive_losses = (1 - ev_b_50['win_rate']) ** max_consecutive_losses
    print(f"      Trades para ruina (pérdidas consecutivas): ~{max_consecutive_losses}")
    print(f"      P({max_consecutive_losses} pérdidas consecutivas): {prob_consecutive_losses:.2%}")

    # ============================================================================
    # 3. FRECUENCIA DE OPORTUNIDADES
    # ============================================================================
    print("\n" + "=" * 80)
    print("3. FRECUENCIA DE OPORTUNIDADES")
    print("-" * 80)

    freq_analysis = analyzer.frequency_analysis(
        strategy_a_opportunities_per_day=20,  # Dips de 4% más frecuentes
        strategy_b_opportunities_per_day=5    # Dips de 15% menos frecuentes
    )

    print("\n📅 PROFIT PROYECTADO:")
    print()
    print("   ESTRATEGIA A:")
    print(f"      Oportunidades/día: {freq_analysis['strategy_a']['opportunities_per_day']}")
    print(f"      EV por trade: ${freq_analysis['strategy_a']['ev_per_trade']:.4f}")
    print(f"      Profit diario: ${freq_analysis['strategy_a']['daily_profit']:.2f}")
    print(f"      Profit mensual: ${freq_analysis['strategy_a']['monthly_profit']:.2f}")
    print()

    print("   ESTRATEGIA B:")
    print(f"      Oportunidades/día: {freq_analysis['strategy_b']['opportunities_per_day']}")
    print(f"      EV por trade: ${freq_analysis['strategy_b']['ev_per_trade']:.4f}")
    print(f"      Profit diario: ${freq_analysis['strategy_b']['daily_profit']:.2f}")
    print(f"      Profit mensual: ${freq_analysis['strategy_b']['monthly_profit']:.2f}")

    # ============================================================================
    # 4. SIMULACIÓN MONTE CARLO
    # ============================================================================
    print("\n" + "=" * 80)
    print("4. SIMULACIÓN MONTE CARLO (1000 trades, 1000 simulaciones)")
    print("-" * 80)

    print("\n⏳ Ejecutando simulación Estrategia A...")
    sim_a = analyzer.monte_carlo_simulation('A', n_trades=1000, n_simulations=1000)

    print("\n📊 ESTRATEGIA A - Resultados:")
    print(f"   Profit promedio: ${sim_a['mean_profit']:.2f}")
    print(f"   Profit mediano: ${sim_a['median_profit']:.2f}")
    print(f"   Std dev: ${sim_a['std_profit']:.2f}")
    print(f"   Rango: [${sim_a['min_profit']:.2f}, ${sim_a['max_profit']:.2f}]")
    print(f"   Max drawdown promedio: {sim_a['mean_max_drawdown']*100:.2f}%")
    print(f"   Peor drawdown: {sim_a['worst_drawdown']*100:.2f}%")
    print(f"   Sharpe ratio: {sim_a['sharpe_ratio']:.3f}")
    print(f"   P(profit > 0): {sim_a['prob_profit']*100:.1f}%")

    print("\n⏳ Ejecutando simulación Estrategia B...")
    sim_b = analyzer.monte_carlo_simulation('B', n_trades=1000, n_simulations=1000,
                                            leg2_execution_prob=0.50)

    print("\n📊 ESTRATEGIA B - Resultados:")
    print(f"   Profit promedio: ${sim_b['mean_profit']:.2f}")
    print(f"   Profit mediano: ${sim_b['median_profit']:.2f}")
    print(f"   Std dev: ${sim_b['std_profit']:.2f}")
    print(f"   Rango: [${sim_b['min_profit']:.2f}, ${sim_b['max_profit']:.2f}]")
    print(f"   Max drawdown promedio: {sim_b['mean_max_drawdown']*100:.2f}%")
    print(f"   Peor drawdown: {sim_b['worst_drawdown']*100:.2f}%")
    print(f"   Sharpe ratio: {sim_b['sharpe_ratio']:.3f}")
    print(f"   P(profit > 0): {sim_b['prob_profit']*100:.1f}%")

    # ============================================================================
    # 5. RECOMENDACIÓN FINAL
    # ============================================================================
    print("\n" + "=" * 80)
    print("5. RECOMENDACIÓN FINAL")
    print("=" * 80)
    print()

    print("🎯 ANÁLISIS COMPARATIVO:")
    print()

    # Comparar EVs
    print(f"1. Expected Value:")
    print(f"   Estrategia A: ${ev_a['ev']:.4f} por trade (100% garantizado)")
    print(f"   Estrategia B: ${ev_b_50['ev_total']:.4f} por trade (P(Leg2)=50%)")
    print(f"   → Ventaja: {'B' if ev_b_50['ev_total'] > ev_a['ev'] else 'A'}")
    print()

    # Comparar riesgo
    print(f"2. Riesgo:")
    print(f"   Estrategia A: σ = $0 (sin riesgo)")
    print(f"   Estrategia B: σ = ${ev_b_50['std_dev']:.4f}")
    print(f"   → Ventaja: A (mucho menor riesgo)")
    print()

    # Comparar profit total
    print(f"3. Profit Total (considerando frecuencia):")
    print(f"   Estrategia A: ${freq_analysis['strategy_a']['monthly_profit']:.2f}/mes")
    print(f"   Estrategia B: ${freq_analysis['strategy_b']['monthly_profit']:.2f}/mes")
    print(f"   → Ventaja: {'B' if freq_analysis['strategy_b']['monthly_profit'] > freq_analysis['strategy_a']['monthly_profit'] else 'A'}")
    print()

    # Comparar Sharpe
    print(f"4. Risk-Adjusted Return (Sharpe Ratio):")
    print(f"   Estrategia A: {sim_a['sharpe_ratio']:.3f}")
    print(f"   Estrategia B: {sim_b['sharpe_ratio']:.3f}")
    print(f"   → Ventaja: {'B' if sim_b['sharpe_ratio'] > sim_a['sharpe_ratio'] else 'A'}")
    print()

    print("=" * 80)
    print("🏆 RECOMENDACIÓN:")
    print("=" * 80)
    print()
    print("ESTRATEGIA HÍBRIDA (Combinar A + B):")
    print()
    print("1. USAR ESTRATEGIA A como base:")
    print("   ✓ Profit garantizado, sin riesgo")
    print("   ✓ Mayor frecuencia de oportunidades")
    print("   ✓ Capital crece consistentemente")
    print()
    print("2. AGREGAR ESTRATEGIA B selectivamente:")
    print("   ✓ Solo cuando P(Leg 2) > 50% (basado en datos históricos)")
    print("   ✓ Limitar capital en riesgo: máx 20% del portafolio en Leg 1")
    print("   ✓ Usar solo cuando hay alta confianza en reversión")
    print()
    print("3. CRITERIOS PARA ESTRATEGIA B:")
    print("   • Caída ≥ 15% en < 3 segundos")
    print("   • Primeros 2 minutos del round")
    print("   • Volatilidad histórica sugiere reversión")
    print("   • Spread bid-ask favorable para Leg 2")
    print()
    print("EJEMPLO DE ASIGNACIÓN:")
    print("   • 80% capital → Estrategia A (profit estable)")
    print("   • 20% capital → Estrategia B (upside potencial)")
    print()
    print(f"PROFIT ESPERADO MENSUAL (híbrido):")
    profit_hybrid = (0.8 * freq_analysis['strategy_a']['monthly_profit'] +
                    0.2 * freq_analysis['strategy_b']['monthly_profit'])
    print(f"   ${profit_hybrid:.2f}/mes")
    print(f"   ({(profit_hybrid/1000)*100:.1f}% ROI mensual)")
    print()
    print("=" * 80)

    # Guardar visualizaciones
    create_visualizations(sim_a, sim_b, ev_a, ev_b_50)

def create_visualizations(sim_a, sim_b, ev_a, ev_b):
    """Crear visualizaciones de los resultados"""

    fig, axes = plt.subplots(2, 2, figsize=(15, 10))

    # 1. Distribución de profits
    ax1 = axes[0, 0]
    ax1.hist(sim_a['profit_distribution'], bins=50, alpha=0.6, label='Estrategia A', color='blue')
    ax1.hist(sim_b['profit_distribution'], bins=50, alpha=0.6, label='Estrategia B', color='red')
    ax1.axvline(sim_a['mean_profit'], color='blue', linestyle='--', linewidth=2, label=f'Media A: ${sim_a["mean_profit"]:.0f}')
    ax1.axvline(sim_b['mean_profit'], color='red', linestyle='--', linewidth=2, label=f'Media B: ${sim_b["mean_profit"]:.0f}')
    ax1.set_xlabel('Profit Total (1000 trades)')
    ax1.set_ylabel('Frecuencia')
    ax1.set_title('Distribución de Profit - Monte Carlo (1000 simulaciones)')
    ax1.legend()
    ax1.grid(True, alpha=0.3)

    # 2. Box plot comparativo
    ax2 = axes[0, 1]
    data_to_plot = [sim_a['profit_distribution'], sim_b['profit_distribution']]
    bp = ax2.boxplot(data_to_plot, labels=['Estrategia A', 'Estrategia B'], patch_artist=True)
    bp['boxes'][0].set_facecolor('blue')
    bp['boxes'][1].set_facecolor('red')
    ax2.set_ylabel('Profit Total ($)')
    ax2.set_title('Comparación de Distribuciones')
    ax2.grid(True, alpha=0.3, axis='y')

    # 3. EV vs Probabilidad Leg 2
    ax3 = axes[1, 0]
    probs = np.linspace(0, 1, 100)
    analyzer = StrategyAnalyzer()
    evs_b = [analyzer.strategy_b_ev(leg2_execution_prob=p)['ev_total'] for p in probs]

    ax3.plot(probs * 100, evs_b, 'r-', linewidth=2, label='EV Estrategia B')
    ax3.axhline(ev_a['ev'], color='blue', linestyle='--', linewidth=2, label=f'EV Estrategia A: ${ev_a["ev"]:.4f}')
    ax3.set_xlabel('P(Leg 2 ejecuta) %')
    ax3.set_ylabel('Expected Value ($)')
    ax3.set_title('EV Estrategia B vs Probabilidad Leg 2')
    ax3.legend()
    ax3.grid(True, alpha=0.3)

    # 4. Sharpe Ratio vs Probabilidad Leg 2
    ax4 = axes[1, 1]
    sharpes_b = []
    for p in [0.3, 0.4, 0.5, 0.6, 0.7]:
        sim = analyzer.monte_carlo_simulation('B', n_trades=1000, n_simulations=100, leg2_execution_prob=p)
        sharpes_b.append(sim['sharpe_ratio'])

    probs_sample = [0.3, 0.4, 0.5, 0.6, 0.7]
    ax4.plot(np.array(probs_sample) * 100, sharpes_b, 'ro-', linewidth=2, markersize=8, label='Sharpe B')
    ax4.axhline(sim_a['sharpe_ratio'], color='blue', linestyle='--', linewidth=2, label=f'Sharpe A: {sim_a["sharpe_ratio"]:.3f}')
    ax4.set_xlabel('P(Leg 2 ejecuta) %')
    ax4.set_ylabel('Sharpe Ratio')
    ax4.set_title('Risk-Adjusted Return vs Probabilidad Leg 2')
    ax4.legend()
    ax4.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/Users/fran/Documents/Mitrol/agentic-employees/polymarket-dip-bot/strategy_analysis.png', dpi=300, bbox_inches='tight')
    print("\n📊 Visualizaciones guardadas en: strategy_analysis.png")

if __name__ == '__main__':
    main()
