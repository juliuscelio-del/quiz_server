# GNHS Quiz — Teacher App (Mac / Windows)

The quiz server and the teacher dashboard in one app. Open it and the dashboard appears.
Students on the same Wi-Fi find it automatically with the student app.

## Where your data is saved
Everything the server saves (results, archive, roster, points, item bank, exams, pictures,
license.key) lives in ONE data folder that belongs to this app:

- **Mac:** `~/Library/Application Support/GNHS Quiz Teacher/data`
- **Windows:** `%APPDATA%\GNHS Quiz Teacher\data`

It is NOT inside the program files, so updating or reinstalling the app never erases it.
In the app: **File → Open Data Folder** takes you straight there.

## School & Roster (using this app at another school)
Click **🏫 School & Roster** in the dashboard (admin password required). There you can change:
- **School:** name, school year, location, region/division (item-analysis printouts) and the logo.
- **Sections & Subjects:** grade levels, section names and subjects.
- **Students:** add / edit / remove, paste a list, or import a .csv / .xlsx / .txt file (Name, Section, Gender).

Everything is saved in `school.json` and `students.json` in the data folder. Renaming a section or subject keeps its
students, enabled/disabled state and exams, but needs a clean slate first (archive & reset current results).
Old archived results keep the names they were saved under.
The **admin password** is also changed there (stored hashed in `admin.json`; until you change it the old built-in password still works).
Note: the license is still tied to each computer, so a new school's computer must be approved first.

## Safety copies
- **Save button:** the green **💾 Save** button at the top of the dashboard (or **File → Save Now**, Cmd+S) writes everything to disk right away and keeps a dated copy in Documents/GNHS Quiz Backups/Saved (last 30 kept). Use it after each quiz.
- **Automatic:** every time you quit, the app keeps a copy in `auto-backups` (last 10 kept).
- **Manual:** **File → Back Up Data…** saves a dated copy to Documents/GNHS Quiz Backups.
  Copy that folder to a USB drive or cloud drive after each quiz.

## First run
The app asks if you have an old SERVER folder. Choose it and your students, results and
license.key are copied in (your old folder is not changed). You can do this later with
**File → Import From Old SERVER Folder…**

## Build on GitHub
1. Create a **Private** repository (the code contains your license secret and admin password).
2. Upload everything in this folder (include the hidden `.github` folder).
3. **Actions → Build Teacher app → Run workflow.**
4. Download **GNHS-Quiz-Teacher-Mac** (.dmg/.zip) and **GNHS-Quiz-Teacher-Windows** (.exe) from Artifacts.

## Notes
- The license is tied to the computer. Importing your old SERVER folder brings license.key along.
  A new computer needs a new license.key from Julius Celio (the app shows the machine ID to send).
- Closing the window stops the server, so the app asks first.
- Allow the app through the firewall when asked (TCP 3000, UDP 41234).
- Mac: unsigned, so run once: `xattr -dr com.apple.quarantine "/Applications/GNHS Quiz Teacher.app"`
- Windows: SmartScreen may warn: More info → Run anyway.
- `generate_reports.py` is not part of the app. Use the dashboard's Export CSV, or ask for a
  version that reads the data folder.
