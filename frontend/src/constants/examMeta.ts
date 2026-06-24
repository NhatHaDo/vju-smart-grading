export const SEMESTER_OPTIONS = [
  { value: 'I',   label: 'Kỳ I'  },
  { value: 'II',  label: 'Kỳ II' },
  { value: 'III', label: 'Kỳ III' },
  { value: 'HE',  label: 'Kỳ hè' },
];

export const LECTURER_TITLE_OPTIONS = ['TS.', 'ThS.', 'TS./ThS.'];

export const FACULTY_OPTIONS = [
  { value: 'FATE', label: 'Khoa Khoa học và Công nghệ tiên tiến (FATE)' },
  { value: 'SHSS', label: 'Khoa Khoa học Xã hội liên ngành (SHSS)' },
];

export const TRAINING_PROGRAMS: Record<string, string[]> = {
  FATE: [
    'Khoa học và Kỹ thuật máy tính',
    'Cơ điện tử thông minh và sản xuất theo phương thức Nhật Bản',
    'Công nghệ thực phẩm và Sức khỏe',
    'Nông nghiệp thông minh và Bền vững',
    'Kỹ thuật Xây dựng',
    'Đổi mới và Phát triển toàn cầu',
    'Công nghệ kỹ thuật Chip bán dẫn',
    'Điều khiển thông minh và Tự động hóa',
  ],
  SHSS: [
    'Nhật Bản học',
    'Khu vực học',
    'Quản trị kinh doanh',
    'Chính sách công',
    'Lãnh đạo toàn cầu',
    'Biến đổi khí hậu và phát triển',
  ],
};

export function labelFromOptions(
  options: Array<{ value: string; label: string }>,
  value: string,
): string {
  return options.find(o => o.value === value)?.label ?? value ?? '—';
}

export const semesterLabel  = (value: string) => labelFromOptions(SEMESTER_OPTIONS, value);
export const facultyLabel   = (value: string) => labelFromOptions(FACULTY_OPTIONS,  value);
export const lecturerDisplay = (exam: { lecturer_title?: string; lecturer_name?: string }) =>
  [exam?.lecturer_title, exam?.lecturer_name].filter(Boolean).join(' ') || '—';

export function currentAcademicYear(): string {
  const now  = new Date();
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}/${year + 1}`;
}
