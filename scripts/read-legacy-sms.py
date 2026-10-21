#!/usr/bin/env python3
"""Read an SQLite backup without loading or executing legacy application code."""
import json
import sqlite3
import sys
from pathlib import Path

source = Path(sys.argv[1]).resolve(strict=True)
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    students = [dict(r) for r in db.execute('''
        SELECT id,name,student_no,gender,grade,school,status,enrollment_date,current_stage,elo_rating,rating_internal
        FROM student ORDER BY id
    ''')]
    accounts = [dict(r) for r in db.execute('''
        SELECT student_id,username FROM account
        WHERE student_id IS NOT NULL AND student_id != '' ORDER BY student_id,username
    ''')]
    history = [dict(r) for r in db.execute('''
        SELECT id,student_id,exam_id,exam_name,exam_date,rating_after
        FROM elo_change ORDER BY student_id,exam_date,id
    ''')]
    db.rollback()
print(json.dumps({'students': students, 'accounts': accounts, 'history': history}, ensure_ascii=False))
