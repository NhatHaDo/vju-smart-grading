/**
 * Badge — coloured status pill
 */
interface BadgeProps {
  children: React.ReactNode;
  color?: 'red' | 'yellow' | 'green' | 'blue' | 'gray' | 'purple';
}

const COLOR_MAP: Record<NonNullable<BadgeProps['color']>, { bg: string; text: string }> = {
  red:    { bg: '#FEE2E2', text: '#991B1B' },
  yellow: { bg: '#FEF9C3', text: '#854D0E' },
  green:  { bg: '#D1FAE5', text: '#065F46' },
  blue:   { bg: '#DBEAFE', text: '#1E40AF' },
  gray:   { bg: '#F3F4F6', text: '#374151' },
  purple: { bg: '#EDE9FE', text: '#5B21B6' },
};

export default function Badge({ children, color = 'gray' }: BadgeProps) {
  const { bg, text } = COLOR_MAP[color];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 9px',
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 700,
        background: bg,
        color: text,
        whiteSpace: 'nowrap',
        lineHeight: 1.6,
      }}
    >
      {children}
    </span>
  );
}
