/** Draft structured history from text the applicant has already reviewed. Never verify it here. */
export type DraftEmployment = {
  employer: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  evidenceSummary: string | null;
  sourceEmployerLine: string;
};

export type DraftEducation = {
  institution: string;
  qualification: string;
  field: string | null;
  startDate: string | null;
  endDate: string | null;
  grade: string | null;
  sourceLine: string;
};

export type CvHistoryDraft = {
  employment: DraftEmployment[];
  education: DraftEducation[];
  warnings: string[];
};

const month =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const datedTitle = new RegExp(
  `^(.+?)\\s+(${month}\\s+\\d{4})\\s*[–—-]\\s*(${month}\\s+\\d{4}|Present|Current)$`,
  'i',
);
const bullet = /^[•*\-–—]\s+/;

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function draftHistoryFromReviewedCv(
  employmentText: string,
  educationText: string,
): CvHistoryDraft {
  const warnings: string[] = [];
  const employment: DraftEmployment[] = [];
  const lines = employmentText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const match = datedTitle.exec(lines[index] ?? '');
    if (match === null) continue;
    const employerLine = lines[index + 1] ?? '';
    if (employerLine === '' || bullet.test(employerLine) || datedTitle.test(employerLine)) {
      warnings.push(
        `The employer for role ${String(employment.length + 1)} could not be identified; check the CV.`,
      );
      continue;
    }
    const duties: string[] = [];
    index += 1;
    while (index + 1 < lines.length && !datedTitle.test(lines[index + 1] ?? '')) {
      index += 1;
      duties.push(lines[index] ?? '');
    }
    employment.push({
      // CV lines often append a town or work pattern. The applicant must review this field.
      employer: clean(employerLine),
      title: clean(match[1] ?? ''),
      startDate: clean(match[2] ?? ''),
      endDate: /^(?:present|current)$/i.test(match[3] ?? '') ? null : clean(match[3] ?? ''),
      evidenceSummary: duties.length === 0 ? null : clean(duties.join(' ')),
      sourceEmployerLine: employerLine,
    });
  }
  if (employment.length === 0 && employmentText.trim() !== '') {
    warnings.push(
      'No dated roles could be extracted automatically. Add them from the CV before confirming.',
    );
  }
  if (employment.length > 0) {
    warnings.push(
      'Check every employer name: a CV line may include a town or work pattern after it.',
    );
    warnings.push(
      'Only month and year are present in the CV. Do not invent a day when an application asks for one.',
    );
  }

  const education: DraftEducation[] = [];
  for (const sourceLine of educationText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const parts = sourceLine.split(/\s+[–—-]\s+/, 2);
    if (parts.length !== 2) {
      warnings.push(
        'An education line was not recognised. Compare the draft with the CV before confirming.',
      );
      continue;
    }
    const detail = (parts[1] ?? '').split(/\s*\|\s*/, 2);
    const status = detail[1] ?? '';
    const completed = /\bcompleted\s+(.+)$/i.exec(status);
    const commenced = /\bcommenced\s+(.+)$/i.exec(status);
    const year = /\b(19|20)\d{2}\b/.exec(status);
    education.push({
      institution: clean(detail[0] ?? ''),
      qualification: clean(parts[0] ?? ''),
      field: null,
      startDate: commenced === null ? null : clean(commenced[1] ?? ''),
      endDate:
        completed === null
          ? commenced === null
            ? (year?.[0] ?? null)
            : null
          : clean(completed[1] ?? ''),
      grade: null,
      sourceLine,
    });
  }
  if (education.length === 0 && educationText.trim() !== '') {
    warnings.push(
      'No qualifications could be extracted automatically. Add them from the CV before confirming.',
    );
  }
  return { employment, education, warnings };
}
