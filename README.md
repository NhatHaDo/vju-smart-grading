# VJU Smart Grading

A web-based Optical Mark Recognition (OMR) exam grading system for processing multiple-choice answer sheets.

The system supports exam management, answer key setup, template handling, answer sheet upload, automatic grading, result review, and audit tracking.

## Overview

**VJU Smart Grading** is designed to reduce the time and errors involved in manual multiple-choice exam grading.

In real exam workflows, scanned answer sheets may contain issues such as image misalignment, unclear marks, multiple selected answers, blank answers, or incorrect template matching. This project provides a structured web application that helps users upload answer sheets, process them through an OMR pipeline, review uncertain cases, and manage grading results.

## Problem

Manual grading can be:

* Time-consuming when handling many answer sheets.
* Error-prone due to unclear marks or multiple selected answers.
* Difficult to review when results are stored manually.
* Hard to track when there is no processing log or audit trail.

This project aims to provide a software solution that improves grading speed, result management, and reviewability.

## Main Features

* User authentication
* Exam management
* Answer key management
* OMR template management
* Answer sheet upload
* Automatic bubble detection
* Student/exam information extraction
* Grading result review
* Unclear or multiple-mark handling
* Result export
* Processing logs and audit logs

## Tech Stack

| Layer          | Technologies                                |
| -------------- | ------------------------------------------- |
| Frontend       | Vite, React, TypeScript, Tailwind CSS       |
| Backend        | FastAPI, SQLAlchemy, SQLite                 |
| OMR Core       | Python, OpenCV, OMRChecker-based processing |
| Authentication | JWT access/refresh tokens, bcrypt           |
| Tools          | Git, GitHub, VS Code, Postman               |

## System Architecture

```text
vju-smart-grading/
├── frontend/              # Vite + React + TypeScript frontend
├── backend/               # FastAPI backend
│   └── app/
│       ├── api/v1/routes/ # API endpoints
│       ├── services/      # Business logic
│       ├── repositories/  # Database operations
│       ├── models/        # SQLAlchemy models
│       ├── schemas/       # Pydantic schemas
│       └── core/omr/      # OMR processing modules
├── docs/                  # Documentation
├── sample-data/           # Sample input files
├── .env.example
└── README.md
```

## Core Workflow

```text
Create exam
→ Set answer key
→ Upload answer sheets
→ Process sheets with OMR
→ Detect marked bubbles
→ Generate grading results
→ Review uncertain cases
→ Export results
```

## OMR Processing Flow

1. Upload scanned answer sheet.
2. Apply image preprocessing using OpenCV.
3. Match the sheet with the selected template.
4. Detect answer bubbles and marked regions.
5. Extract selected answers and student/exam information.
6. Compare detected answers with the answer key.
7. Generate grading results and review flags.

## Testing Focus

During development, the following flows were manually tested:

* Login and authentication flow
* Exam CRUD operations
* Answer key setup
* Template management
* Sheet upload flow
* OMR processing result validation
* Invalid input handling
* Blank answer handling
* Multiple-mark or unclear-mark cases
* Result review and export flow

## Skills Demonstrated

* Full-stack web development
* RESTful API design
* Database modeling
* Authentication flow
* Image processing with OpenCV
* OMR pipeline integration
* Manual testing and edge case analysis
* System workflow design
* Git/GitHub project management

## Project Status

First working version completed for academic and portfolio purposes.

Future improvements may include:

* More robust template editor
* Batch processing for large exam sets
* Improved result review UI
* Role-based access control
* More detailed audit logs
* Deployment for online demo usage
* Automated test cases
* Export formats such as CSV and Excel

## Author

Huyen Do
Computer Science and Engineering Student
Vietnam Japan University
