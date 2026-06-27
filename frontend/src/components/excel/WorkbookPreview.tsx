/**
 * WorkbookPreview.tsx
 *
 * Renders a single DisplaySheet (extracted from an ExcelJS workbook) as an
 * Excel-like HTML table. Supports:
 *   - Column letters / row numbers gutters
 *   - Merged cells (colSpan / rowSpan)
 *   - Cell fill/font/alignment from workbook model
 *   - Light formula bar (no dark background)
 *   - Optional editable mode: double-click non-formula cell to edit
 *
 * Props:
 *   sheet        — the DisplaySheet to render
 *   maxHeight    — max height of the scrollable grid (default '65vh')
 *   editable     — if true, double-click activates inline cell editing
 *   onCellChange — called with (sheetName, row1based, col1based, newValue) on commit
 */

import { useState, useRef } from 'react';
import type { DisplaySheet, DisplayCell } from '../../utils/excelWorkbookBuilder';

// ── Palette ───────────────────────────────────────────────────────────────────

const P = {
  pageBg:      '#f4f5f7',
  gridBg:      '#ffffff',
  colHdrBg:    '#f1f5f9',
  colHdrTxt:   '#64748b',
  rowNumBg:    '#f1f5f9',
  rowNumTxt:   '#64748b',
  cellBorder:  '#e5e7eb',
  cellBorderH: '#d1d5db',
  selectBg:    '#dcfce7',
  editBg:      '#fef9c3',
  fbarBg:      '#f1f5f9',
  fbarBorder:  '#e5e7eb',
  fbarTxt:     '#1a1a1a',
  fbarAddr:    '#1B5E20',
  fbarFx:      '#1B5E20',
  footerBg:    '#f8fafc',
  footerTxt:   '#94a3b8',
} as const;

const ROW_NUM_W  = 42;
const COL_HDR_H  = 22;

const CORNER_STYLE: React.CSSProperties = {
  width:       ROW_NUM_W,
  minWidth:    ROW_NUM_W,
  height:      COL_HDR_H,
  background:  P.colHdrBg,
  borderRight: `2px solid ${P.cellBorderH}`,
  borderBottom:`2px solid ${P.cellBorderH}`,
  position:    'sticky',
  top:         0,
  left:        0,
  zIndex:      30,
};

const COL_HDR_STYLE: React.CSSProperties = {
  height:       COL_HDR_H,
  background:   P.colHdrBg,
  color:        P.colHdrTxt,
  fontWeight:   700,
  fontSize:     10,
  textAlign:    'center',
  verticalAlign:'middle',
  borderRight:  `1px solid ${P.cellBorder}`,
  borderBottom: `2px solid ${P.cellBorderH}`,
  position:     'sticky',
  top:          0,
  zIndex:       20,
  userSelect:   'none',
  letterSpacing:'0.04em',
  padding:      '0 4px',
};

const ROW_NUM_STYLE: React.CSSProperties = {
  width:        ROW_NUM_W,
  minWidth:     ROW_NUM_W,
  background:   P.rowNumBg,
  color:        P.rowNumTxt,
  textAlign:    'right',
  fontSize:     10,
  fontWeight:   500,
  borderRight:  `2px solid ${P.cellBorderH}`,
  borderBottom: `1px solid ${P.cellBorder}`,
  userSelect:   'none',
  paddingRight: 6,
  verticalAlign:'middle',
  position:     'sticky',
  left:         0,
  zIndex:       10,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function cellStyle(
  cell: DisplayCell,
  selected: boolean,
  editing: boolean,
  editable: boolean,
  rowH: number,
): React.CSSProperties {
  const bg = editing
    ? P.editBg
    : selected
    ? P.selectBg
    : (cell.fillColor ?? P.gridBg);

  return {
    background:    bg,
    color:         cell.fontColor ?? '#1F2937',
    fontFamily:    "'Calibri', 'Segoe UI', Arial, sans-serif",
    fontWeight:    cell.fontBold  ? 700 : 400,
    fontSize:      cell.fontSize  ?? 11,
    fontStyle:     cell.fontItalic ? 'italic' : 'normal',
    textAlign:     (cell.hAlign ?? 'left') as React.CSSProperties['textAlign'],
    verticalAlign: 'middle',
    whiteSpace:    cell.wrapText ? 'pre-wrap' : 'nowrap',
    overflow:      editing ? 'visible' : 'hidden',
    textOverflow:  editing ? 'unset'   : 'ellipsis',
    height:        rowH,
    padding:       editing ? 0 : '0 6px',
    boxSizing:     'border-box',
    borderRight:   cell.hasBorder ? '1px solid #D1D5DB' : `1px solid ${P.cellBorder}`,
    borderBottom:  cell.hasBorder ? '1px solid #D1D5DB' : `1px solid ${P.cellBorder}`,
    cursor:        editable && !cell.formula ? 'text' : 'default',
    outline:       editing ? '2px solid #1B5E20' : 'none',
    position:      'relative',
  };
}

function colLetterFn(n: number): string {
  let result = '', i = n;
  while (i > 0) {
    i--;
    result = String.fromCharCode(65 + (i % 26)) + result;
    i = Math.floor(i / 26);
  }
  return result;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  sheet:         DisplaySheet;
  maxHeight?:    string;
  editable?:     boolean;
  onCellChange?: (sheetName: string, row: number, col: number, value: string) => void;
}

interface EditState { r: number; c: number; draft: string }

// ── Component ─────────────────────────────────────────────────────────────────

export default function WorkbookPreview({
  sheet,
  maxHeight = '65vh',
  editable  = false,
  onCellChange,
}: Props) {
  const [selected,    setSelected]    = useState<{ r: number; c: number } | null>(null);
  const [editingCell, setEditingCell] = useState<EditState | null>(null);
  // prevents blur from committing after Escape
  const cancelRef = useRef(false);

  // ── Formula bar ─────────────────────────────────────────────────────────

  const activeCellPos = editingCell ?? selected;
  const selCell       = activeCellPos
    ? (sheet.rows[activeCellPos.r - 1]?.cells[activeCellPos.c - 1] ?? null)
    : null;
  const cellAddr      = activeCellPos ? `${colLetterFn(activeCellPos.c)}${activeCellPos.r}` : '';
  const isFormulaCell = !!selCell?.formula;
  const formulaText   = editingCell
    ? editingCell.draft
    : (selCell?.formula ? `=${selCell.formula}` : (selCell?.value ?? ''));

  // ── Edit helpers ─────────────────────────────────────────────────────────

  function startEdit(r: number, c: number, currentValue: string) {
    if (!editable) return;
    const cell = sheet.rows[r - 1]?.cells[c - 1];
    if (!cell || cell.isSpanned) return;
    if (cell.formula) return;
    cancelRef.current = false;
    setEditingCell({ r, c, draft: currentValue });
    setSelected({ r, c });
  }

  function commitEdit() {
    if (cancelRef.current) { cancelRef.current = false; return; }
    if (!editingCell) return;
    onCellChange?.(sheet.name, editingCell.r, editingCell.c, editingCell.draft);
    setEditingCell(null);
  }

  function cancelEdit() {
    cancelRef.current = true;
    setEditingCell(null);
  }

  // ── Empty sheet ──────────────────────────────────────────────────────────

  if (sheet.rowCount === 0 || sheet.colCount === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#6B7280', fontSize: 13 }}>
        Sheet trống
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{
      display:       'flex',
      flexDirection: 'column',
      background:    P.pageBg,
      borderRadius:  8,
      overflow:      'hidden',
      border:        `1px solid ${P.cellBorderH}`,
    }}>

      {/* ── Formula bar — light ── */}
      <div style={{
        display:     'flex',
        alignItems:  'center',
        background:  P.fbarBg,
        padding:     '4px 10px',
        borderBottom:`1px solid ${P.fbarBorder}`,
        gap:         0,
        flexShrink:  0,
        minHeight:   28,
      }}>
        {/* Cell address */}
        <div style={{
          width:       56,
          minWidth:    56,
          fontFamily:  'monospace',
          fontSize:    11,
          fontWeight:  700,
          color:       P.fbarAddr,
          borderRight: `1px solid ${P.fbarBorder}`,
          paddingRight:8,
          marginRight: 8,
          textAlign:   'center',
          userSelect:  'none',
        }}>
          {cellAddr || 'A1'}
        </div>

        {/* fx badge */}
        <span style={{
          color:      P.fbarFx,
          fontSize:   12,
          marginRight:6,
          fontStyle:  'italic',
          fontWeight: 700,
          userSelect: 'none',
        }}>fx</span>

        <div style={{ width: 1, height: 16, background: P.fbarBorder, marginRight: 8 }} />

        {/* Value / formula */}
        <div style={{
          flex:        1,
          fontFamily:  'monospace',
          fontSize:    11,
          color:       isFormulaCell ? '#7c3aed' : P.fbarTxt,
          overflow:    'hidden',
          textOverflow:'ellipsis',
          whiteSpace:  'nowrap',
        }}>
          {formulaText}
        </div>

        {/* Formula read-only badge */}
        {isFormulaCell && (
          <span style={{
            marginLeft:  8,
            fontSize:    10,
            color:       '#7c3aed',
            background:  '#f5f3ff',
            border:      '1px solid #ddd6fe',
            borderRadius:4,
            padding:     '1px 6px',
            whiteSpace:  'nowrap',
            userSelect:  'none',
          }}>
            Công thức tự tính
          </span>
        )}

        {/* Edit hint */}
        {editable && !isFormulaCell && activeCellPos && !editingCell && (
          <span style={{ marginLeft: 8, fontSize: 10, color: '#71717a', userSelect: 'none', whiteSpace: 'nowrap' }}>
            Double-click để sửa
          </span>
        )}
      </div>

      {/* ── Scrollable grid ── */}
      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight }}>
        <table style={{
          borderCollapse:'collapse',
          tableLayout:   'fixed',
          fontFamily:    "'Calibri', 'Segoe UI', Arial, sans-serif",
        }}>
          <colgroup>
            <col style={{ width: ROW_NUM_W, minWidth: ROW_NUM_W }} />
            {sheet.colWidths.map((w, i) => (
              <col key={i} style={{ width: w, minWidth: Math.max(w, 32) }} />
            ))}
          </colgroup>

          <thead>
            <tr style={{ height: COL_HDR_H }}>
              <th style={CORNER_STYLE} />
              {sheet.colLetters.map((letter, ci) => (
                <th key={ci} style={COL_HDR_STYLE}>{letter}</th>
              ))}
            </tr>
          </thead>

          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri} style={{ height: row.height }}>
                <td style={{ ...ROW_NUM_STYLE, height: row.height }}>{ri + 1}</td>

                {row.cells.map((cell, ci) => {
                  if (cell.isSpanned) return null;

                  const r1        = ri + 1;
                  const c1        = ci + 1;
                  const isSelected = selected?.r === r1 && selected?.c === c1;
                  const isEditing  = editingCell?.r === r1 && editingCell?.c === c1;
                  const isFormula  = !!cell.formula;

                  return (
                    <td
                      key={ci}
                      colSpan={cell.colSpan}
                      rowSpan={cell.rowSpan}
                      onClick={() => {
                        if (editingCell) commitEdit();
                        setSelected({ r: r1, c: c1 });
                      }}
                      onDoubleClick={() => {
                        if (editable && !isFormula) startEdit(r1, c1, cell.value);
                      }}
                      style={cellStyle(cell, isSelected, isEditing, editable, row.height)}
                      title={
                        isFormula
                          ? `Công thức: =${cell.formula}\n(chưa hỗ trợ sửa trực tiếp)`
                          : cell.value.length > 40 ? cell.value : undefined
                      }
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editingCell!.draft}
                          onChange={e =>
                            setEditingCell(prev =>
                              prev ? { ...prev, draft: e.target.value } : null
                            )
                          }
                          onKeyDown={e => {
                            if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); }
                            if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                          }}
                          onBlur={commitEdit}
                          style={{
                            width:      '100%',
                            height:     '100%',
                            padding:    '0 6px',
                            border:     'none',
                            outline:    'none',
                            background: 'transparent',
                            fontFamily: "'Calibri', 'Segoe UI', Arial, sans-serif",
                            fontSize:   cell.fontSize ?? 11,
                            fontWeight: cell.fontBold ? 700 : 400,
                            color:      cell.fontColor ?? '#1F2937',
                            textAlign:  (cell.hAlign ?? 'left') as React.CSSProperties['textAlign'],
                            boxSizing:  'border-box',
                          }}
                        />
                      ) : (
                        cell.value
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Status bar ── */}
      <div style={{
        padding:    '3px 10px',
        background: P.footerBg,
        borderTop:  `1px solid ${P.fbarBorder}`,
        fontSize:   10,
        color:      P.footerTxt,
        display:    'flex',
        gap:        16,
        flexShrink: 0,
        alignItems: 'center',
      }}>
        <span>{sheet.rowCount} dòng · {sheet.colCount} cột</span>
        {selCell?.formula && (
          <span style={{ color: '#7c3aed' }}>={selCell.formula}</span>
        )}
        {editable && (
          <span style={{ color: '#16a34a' }}>
            ✎ Chế độ chỉnh sửa — double-click ô để sửa
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: '#cbd5e1' }}>Render từ workbook Excel thật</span>
      </div>
    </div>
  );
}
