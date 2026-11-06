// ===== テーマごとの石色・色名（2〜6人対応） =====
const NAMES = ['', '黒', '白', '赤', '青', '黄', '紫'];
const PLAYER_COLORS = [{fill:'#171717',stroke:'#333333'},{fill:'#ffffff',stroke:'#333333'},{fill:'#e4471f',stroke:'#333333'},{fill:'#2878d0',stroke:'#333333'},{fill:'#d68910',stroke:'#333333'},{fill:'#8e44ad',stroke:'#333333'}];
function playerFill(p){ const o = (typeof G !== 'undefined' && G && G.photoColors && G.photoColors[p]); return (o && o.fill) || (theme.fill[p] || PLAYER_COLORS[p-1]?.fill || '#888888'); }
function playerStroke(p){ const o = (typeof G !== 'undefined' && G && G.photoColors && G.photoColors[p]); return (o && o.stroke) || (theme.stroke[p] || PLAYER_COLORS[p-1]?.stroke || '#333333'); }
function playerName(p){ const pn = (typeof G !== 'undefined' && G && G.photoNames && G.photoNames[p]); return pn || (theme.names && theme.names[p]) || NAMES[p] || `プレイヤー${p}`; }
const mk = (id, name, bg, tx, board, line, card, bd, fills, edge, names) => ({
  id, name, bg, tx, board, line, card, bd,
  fill: [0, ...fills], stroke: [0, ...Array.from({length:6}, () => edge)],
  names: ['', ...names]
});
const THEMES = {
  default: mk('default', '五行思想（白背景）', '#ffffff', '#171717', '#ffffff', '#777777', '#fafafa', '#e5e5e5',
    ['#111111', '#F4F4F4', '#E53935', '#1769AA', '#F0A000', '#9B2FCB'], '#555555', ['黒', '白', '赤', '青', '黄', '紫']),
  dark: mk('dark', 'ダークモード', '#171717', '#f5f5f5', '#202020', '#777777', '#262626', '#3a3a3a',
    ['#1A1A1A', '#FFFFFF', '#FF2A6D', '#00E5FF', '#F4D03F', '#05FFA1'], '#B8B8B8', ['黒', '白', 'マゼンタ', 'シアン', 'イエロー', 'グリーン']),
  go: mk('go', '和風色名（木目風）', '#D9B382', '#3e2211', '#D9B382', '#7B5A36', '#ebd19d', '#cbb07a',
    ['#1B1B1B', '#F9F6EE', '#eb6101', '#2B6492', '#f8b500', '#bbbcde'], '#5C4033', ['黒', '白', '朱', '縹', '山吹', '藤色']),
  cyber: mk('cyber', 'サイバーモード', '#101827', '#e0f2fe', '#101827', '#38bdf8', '#172033', '#334155',
    ['#0F172A', '#F8FAFC', '#FF007F', '#00F0FF', '#39FF14', '#BD00FF'], '#94A3B8', ['黒', '白', 'ピンク', 'シアン', 'ライム', '紫']),
  fancy: mk('fancy', 'ファンシーモード', '#FFF0F5', '#4a044e', '#FFF0F5', '#e7a6c2', '#fae8ff', '#f5d0fe',
    ['#171717', '#ffffff', '#FF85A1', '#70D6FF', '#FFD670', '#9B5DE5'], '#8B7180', ['黒', '白', 'ピンク', '青', '黄', '紫'])
};
let theme = THEMES.default;
