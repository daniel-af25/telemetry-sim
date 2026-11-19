# Diretrizes de Engenharia para o Google Antigravity

Colabora como copiloto técnico sob rigorosa auditoria humana.
Regras obrigatórias:

1. ESCOPO CIRÚRGICO:
   - Modifique APENAS a função ou ficheiro solicitado.
   - Não altere assinaturas de funções sem autorização prévia.

2. CONVENÇÃO DE SINAIS (ISO 8855 / ENU — Fronteira Única em `src/core/calibration.ts`):
   - `+ax`: aceleração frontal | `-ax`: travagem. Entrada LABSIS: `ax = +compensatedLonG * 9.80665` (a partir de `accelY` / `accel_lon_comp_g`).
   - `+ay`: curva à esquerda | `-ay`: curva à direita (ISO 8855). Entrada LABSIS: `ay = -compensatedLatG * 9.80665` (a partir de `accelX` / `accel_lat_comp_g`).
   - `omega_z`: positivo anti-horário (esquerda) e negativo horário (direita) em `rad/s`. Converter entrada em `°/s` via `* Math.PI / 180`.
   - `roll` positivo = lado direito para baixo (curva à esquerda `+ay`); `pitch` positivo = nariz para baixo (travagem `-ax`).
   - Todos os módulos a jusante de `src/core/calibration.ts` operam exclusivamente em ISO 8855 / SI (`m`, `m/s`, `m/s²`, `rad`, `rad/s`, `N`).

3. INVARIANTES FÍSICOS:
   - Conservação de massa estrita: `Fz_FL + Fz_FR + Fz_RL + Fz_RR == m * g` (tolerância `< 1e-3 N`).
   - Direção a baixas velocidades (Bloco C): aplicar rampa `w_u = clamp((u - 0.3) / 1.2, 0, 1)`, usar `max(u, 1.0)` para evitar divisão por zero/`NaN`, e limitar com clamp `±deltaMax`.
   - Invariantes Kamm v2.2: `brakeLimit >= accelLimit`, e em pisos escorregadios impor sempre `limits <= gripLimitG` (nunca exceder a aderência física).
   - Massa em marcha: usar `curbMassKg + payloadKg` (nunca `gross_weight_kg` / GVWR do catálogo).
   - Lacunas temporais com `dt > 1.0 s` devem fechar clusters de incidentes e saltar derivadas (`jerk`, `du/dt`, *road-grade*).
   - Suficiência de dados para scoring: exigir `>= 1500` amostras (5 min totais a 5 Hz) **E** `>= 120 s` em movimento.

4. PADRÕES & STACK:
   - TypeScript com `"strict": true` e `"noUncheckedIndexedAccess": true` (evitar `as any`).
   - `src/core/` 100% puro, sem DOM e sem bibliotecas externas para cálculos matemáticos (compatível com Vitest/Node.js e Web Workers).
   - Testes unitários e de integração em **Vitest** (`npm run check` deve passar antes de merges).
   - Catálogo de veículos (Opção B): fonte bruta em `data/vehicles.csv` (fora de `src/`), compilada para `public/data/vehicles.index.json` via `npm run build:catalog`.
   - MapLibre GL JS usa tipos nativos (NÃO instalar `@types/maplibre-gl`); qualquer string vinda de CSV deve ser sanitizada (`textContent` / `escapeHtml`).

## Commit Conventions

All commit messages MUST follow Conventional Commits in English:

`<type>(<scope>): <imperative lowercase summary>`

### Allowed Types
| Type | When to use | Example |
| :--- | :--- | :--- |
| `feat` | New feature or calculation | `feat(kamm): calculate dynamic tire friction limits` |
| `test` | Unit test creation or adjustment | `test(kamm): add assertion for wet baseline 0.32G` |
| `fix` | Bug fix, typing fix, or physics error | `fix(parser): adjust timestamp millisecond precision` |
| `refactor` | Code change that does not alter behavior | `refactor(math): extract vector normalization module` |
| `chore` | Tooling, configs, scripts, or dependencies | `chore(deps): update vite and typescript config` |
| `docs` | Technical documentation and `.md` files | `docs: add local test instructions to README` |

### Rules
- Keep the subject line under 72 characters, in the imperative mood, and lowercase (no trailing period).
- `<scope>` is optional for `docs` and `chore`.
- Generate a single-line subject by default (add a bulleted body only if strictly necessary for multi-part changes).