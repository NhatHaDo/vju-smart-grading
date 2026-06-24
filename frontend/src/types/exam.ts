// ── Backend response shape ────────────────────────────────────────────────────
export type ExamStatus = 'draft' | 'active' | 'closed' | 'archived';

/** Matches backend ExamOut schema (snake_case, fields that exist in DB today) */
export interface ExamOut {
  id:             number;
  name:           string;
  /** Subject name — backend field is called "subject" */
  subject:        string;
  exam_code:      string | null;
  status:         ExamStatus;
  owner_id:       number;
  template_id:    number | null;
  total_students: number;
  graded_count:   number;
  exam_date:      string | null;   // YYYY-MM-DD
  notes:          string | null;
  created_at:     string;
  updated_at:     string;

  // ── Phase 2 fields: optional until backend is extended ──────────────────
  subject_code?:       string | null;
  semester?:           string | null;
  academic_year?:      string | null;
  lecturer_title?:     string | null;
  lecturer_name?:      string | null;
  class_name?:         string | null;
  faculty?:            string | null;
  training_program?:   string | null;
  exam_time?:          string | null;
  room?:               string | null;
  shift?:              string | null;
}

/** Alias for backwards compat with other components that import `Exam` */
export type Exam = ExamOut;

// ── Wizard form state ─────────────────────────────────────────────────────────
export interface ExamFormData {
  name:             string;
  subject_name:     string;
  subject_code:     string;
  semester:         string;
  academic_year:    string;
  lecturer_title:   string;
  lecturer_name:    string;
  /** String so <input type="number"> stays controlled; parse on submit */
  student_count:    string;
  class_name:       string;
  faculty:          string;
  training_program: string;
  exam_date:        string;
  exam_time:        string;
  room:             string;
  shift:            string;
  notes:            string;
}

/** Empty wizard form with defaults */
export function emptyForm(defaultAcademicYear = ''): ExamFormData {
  return {
    name: '', subject_name: '', subject_code: '', semester: '',
    academic_year: defaultAcademicYear, lecturer_title: '', lecturer_name: '',
    student_count: '', class_name: '', faculty: '', training_program: '',
    exam_date: '', exam_time: '', room: '', shift: '', notes: '',
  };
}

// ── API payloads ──────────────────────────────────────────────────────────────

/** Payload sent to POST/PUT /exams — all fields now supported by backend (Phase 2). */
export interface ExamCreatePayload {
  name:             string;
  subject:          string;        // maps from form.subject_name
  exam_date?:       string | null;
  total_students?:  number;
  notes?:           string | null;
  subject_code?:    string | null;
  semester?:        string | null;
  academic_year?:   string | null;
  lecturer_title?:  string | null;
  lecturer_name?:   string | null;
  class_name?:      string | null;
  faculty?:         string | null;
  training_program?: string | null;
  exam_time?:       string | null;
  room?:            string | null;
  shift?:           string | null;
}

/** Convert wizard ExamFormData → API ExamCreatePayload */
export function formToPayload(form: ExamFormData): ExamCreatePayload {
  const payload: ExamCreatePayload = {
    name:             form.name.trim(),
    subject:          form.subject_name.trim(),
    exam_date:        form.exam_date     || null,
    notes:            form.notes.trim()  || null,
    subject_code:     form.subject_code.trim()     || null,
    semester:         form.semester                || null,
    academic_year:    form.academic_year.trim()    || null,
    lecturer_title:   form.lecturer_title          || null,
    lecturer_name:    form.lecturer_name.trim()    || null,
    class_name:       form.class_name.trim()       || null,
    faculty:          form.faculty                 || null,
    training_program: form.training_program        || null,
    exam_time:        form.exam_time               || null,
    room:             form.room.trim()             || null,
    shift:            form.shift.trim()            || null,
  };
  const count = parseInt(form.student_count, 10);
  if (!isNaN(count) && count > 0) payload.total_students = count;
  return payload;
}

/** Populate wizard form from an existing ExamOut (for edit flow) */
export function examOutToForm(exam: ExamOut): ExamFormData {
  return {
    name:             exam.name,
    subject_name:     exam.subject,
    subject_code:     exam.subject_code   ?? '',
    semester:         exam.semester        ?? '',
    academic_year:    exam.academic_year   ?? '',
    lecturer_title:   exam.lecturer_title  ?? '',
    lecturer_name:    exam.lecturer_name   ?? '',
    student_count:    exam.total_students > 0 ? String(exam.total_students) : '',
    class_name:       exam.class_name      ?? '',
    faculty:          exam.faculty         ?? '',
    training_program: exam.training_program ?? '',
    exam_date:        exam.exam_date        ?? '',
    exam_time:        exam.exam_time        ?? '',
    room:             exam.room             ?? '',
    shift:            exam.shift            ?? '',
    notes:            exam.notes            ?? '',
  };
}

// ── Legacy alias (kept so AnalyticsPage / SheetReviewPage don't break) ────────
export interface CreateExamPayload extends ExamCreatePayload {}
