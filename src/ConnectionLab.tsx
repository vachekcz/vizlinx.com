import { useState } from 'react';
import { ArrowUpRight, Moon, Sun } from 'lucide-react';
import ConnectionStroke from './ConnectionStroke';
import {
  connectionStrengthLabel,
  fineConnectionStyles,
} from './connectionStyles';
import { useTheme } from './themes';
import './connection-lab.css';

const samples = [1, 2, 3, 4, 5, 8, 12, 25, 50, 120];

export default function ConnectionLab() {
  const { theme, toggleTheme } = useTheme();
  const [count, setCount] = useState(35);
  return (
    <main className="connection-lab" data-theme={theme}>
      <header className="lab-header">
        <div>
          <p className="lab-kicker">STUDIE SPOJNIC / 06–08</p>
          <h1>Od vlákna k dominantní vazbě.</h1>
          <p>
            Stejná barva, stejná délka. Jen tři způsoby, jak ukázat sílu
            propojení.
          </p>
        </div>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={
            theme === 'signal' ? 'Zapnout noční režim' : 'Zapnout denní režim'
          }
        >
          {theme === 'signal' ? <Moon size={17} /> : <Sun size={17} />}
          {theme === 'signal' ? 'Noční režim' : 'Denní režim'}
        </button>
      </header>
      <p className="lab-note">
        1–5 vazeb má stejně tenké samostatné čáry. Nad 5 se začínají spojovat;
        od 10 dál roste šířka a hustota až po 100+. Na mobilu lze tabulku
        posunout do strany.
      </p>
      <div
        className="lab-matrix-scroll"
        tabIndex={0}
        role="region"
        aria-label="Porovnání spojnic podle počtu vazeb"
      >
        <table className="lab-matrix">
          <thead>
            <tr>
              <th scope="col">Varianta</th>
              {samples.map((value) => (
                <th scope="col" key={value}>
                  {connectionStrengthLabel(value)}
                  <small>{value} vazeb</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fineConnectionStyles.map((style, index) => (
              <tr key={style.id}>
                <th scope="row">
                  <small>0{index + 6}</small>
                  {style.name}
                  <a
                    href={`/?theme=${theme}&connections=${style.id}&density=scale`}
                  >
                    Celá mapa <ArrowUpRight size={12} />
                  </a>
                </th>
                {samples.map((value) => (
                  <td key={value} data-lab-style={style.id} data-count={value}>
                    <svg
                      viewBox="0 0 170 110"
                      role="img"
                      aria-label={`${style.name}: ${value} vazeb`}
                    >
                      <ConnectionStroke
                        variant={style.id}
                        from={{ x: 14, y: 74 }}
                        to={{ x: 156, y: 74 }}
                        control={{ x: 85, y: 32 }}
                        color="var(--accent)"
                        count={value}
                        selected={false}
                        markerId="unused"
                      />
                    </svg>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="lab-adjust" aria-label="Plynulé porovnání síly vazeb">
        <div className="lab-slider-row">
          <label htmlFor="lab-count">
            Vyzkoušet vlastní počet{' '}
            <output htmlFor="lab-count">
              {count} vazeb · {connectionStrengthLabel(count)}
            </output>
          </label>
          <input
            id="lab-count"
            type="range"
            min="1"
            max="150"
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          />
        </div>
        <div className="lab-live-variants">
          {fineConnectionStyles.map((style) => (
            <article key={style.id}>
              <h2>{style.name}</h2>
              <svg
                viewBox="0 0 360 140"
                role="img"
                aria-label={`${style.name}, vlastní počet: ${count}`}
              >
                <ConnectionStroke
                  variant={style.id}
                  from={{ x: 20, y: 100 }}
                  to={{ x: 340, y: 100 }}
                  control={{ x: 180, y: 28 }}
                  color="var(--accent)"
                  count={count}
                  selected={false}
                  markerId="unused"
                />
              </svg>
              <p>{style.description}</p>
            </article>
          ))}
        </div>
      </section>
      <footer className="lab-footer">
        <a href="/connections/">
          Náhledy celé mapy <ArrowUpRight size={14} />
        </a>
        <span>Stupně jsou stejné v této studii i v interaktivní mapě.</span>
      </footer>
    </main>
  );
}
