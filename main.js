import './style.css';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Chart from 'chart.js/auto';
import { create, all } from 'mathjs';

const math = create(all);
gsap.registerPlugin(ScrollTrigger);

document.addEventListener('DOMContentLoaded', () => {
  // Reveal animation for sections
  const elements = document.querySelectorAll('.reveal');

  elements.forEach((el) => {
    if (el.id === 'hero') {
      gsap.to(el, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out', delay: 0.1 });
    } else {
      gsap.to(el, {
        scrollTrigger: {
          trigger: el,
          start: 'top 85%',
          toggleActions: 'play none none reverse'
        },
        opacity: 1,
        y: 0,
        duration: 0.8,
        ease: 'power3.out'
      });
    }
  });

  // Radar Chart for Skills
  const radarCtx = document.getElementById('skillsRadarChart');
  if (radarCtx) {
    new Chart(radarCtx.getContext('2d'), {
      type: 'radar',
      data: {
        labels: ['Quantitative Computing', 'Backend Engineering', 'Data Systems', 'Algorithms', 'Mathematical Modeling', 'Systems Architecture'],
        datasets: [{
          label: 'Proficiency',
          data: [90, 85, 88, 75, 95, 80],
          backgroundColor: 'rgba(98, 114, 220, 0.15)',
          borderColor: 'rgba(98, 114, 220, 1)',
          pointBackgroundColor: 'rgba(98, 114, 220, 1)',
          pointBorderColor: '#fafafa',
          pointHoverBackgroundColor: '#fafafa',
          pointHoverBorderColor: 'rgba(98, 114, 220, 1)',
          borderWidth: 2
        }]
      },
      options: {
        scales: {
          r: {
            angleLines: { color: 'rgba(0,0,0,0.06)' },
            grid: { color: 'rgba(0,0,0,0.06)' },
            pointLabels: {
              font: { family: 'JetBrains Mono', size: 11 },
              color: '#525252'
            },
            ticks: { display: false, min: 0, max: 100 }
          }
        },
        plugins: {
          legend: { display: false }
        },
        animation: {
          duration: 1200,
          easing: 'easeOutQuart'
        }
      }
    });
  }

  // Math.js & Chart.js Integration - Geometric Brownian Motion
  // S_t = S_0 * exp((mu - sigma^2 / 2) * t + sigma * W_t)
  const mathCtx = document.getElementById('mathChart');

  if (mathCtx) {
    const T = 1; // 1 year
    const N = 252; // trading days
    const dt = T / N;
    const mu = 0.08; // 8% drift
    const sigma = 0.2; // 20% volatility
    const S0 = 100; // initial price

    // Generate paths
    const timeSteps = math.range(0, N + 1).toArray();
    const numPaths = 3;
    const datasets = [];
    const colors = ['#6272dc', '#10b981', '#f59e0b'];

    for (let i = 0; i < numPaths; i++) {
      let S = [S0];
      for (let t = 1; t <= N; t++) {
        // Box-Muller transform for standard normal random variable
        let u1 = math.random();
        let u2 = math.random();
        let z = math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.PI * u2);

        let prevS = S[t-1];
        let dS = prevS * (mu * dt + sigma * math.sqrt(dt) * z);
        S.push(prevS + dS);
      }

      datasets.push({
        label: `Path ${i+1}`,
        data: S,
        borderColor: colors[i],
        borderWidth: 1.5,
        tension: 0.1,
        pointRadius: 0
      });
    }

    new Chart(mathCtx.getContext('2d'), {
      type: 'line',
      data: {
        labels: timeSteps.map(t => (t/N).toFixed(2)),
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        scales: {
          x: {
            title: { display: true, text: 'Time (Years)', font: { family: 'JetBrains Mono', size: 11 } },
            grid: { display: false, color: 'rgba(0,0,0,0.04)' },
            ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#525252' }
          },
          y: {
            title: { display: true, text: 'Asset Price', font: { family: 'JetBrains Mono', size: 11 } },
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#525252' }
          }
        },
        plugins: {
          legend: {
            labels: { font: { family: 'Geist', size: 11 }, usePointStyle: true, padding: 20 }
          }
        },
        animation: {
          duration: 1500,
          easing: 'easeOutQuart'
        }
      }
    });
  }
});