import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";

interface Output {
  file_path: string;
  problems: Problem[];
}

interface Problem {
  message: string;
  rule_id: string;
  rule_doc_uri: string;
  location: Location;
}

interface Location {
  start_position: Position;
  end_position: Position;
}

interface Position {
  line_number: number;
  column_number: number;
}

function toRange(location: Location): vscode.Range {
  const start = new vscode.Position(
    location.start_position.line_number - 1,
    location.start_position.column_number - 1
  );
  const end = new vscode.Position(
    location.end_position.line_number - 1,
    location.end_position.column_number - 1
  );
  return new vscode.Range(start, end);
}

export interface APILinterOptions {
  channel: vscode.OutputChannel;
}

export class APILinter {
  #channel: vscode.OutputChannel;
  #configFile?: string;
  #protoPaths: string[] = [];
  #directories: string[] | null = null;
  #command: string[] = ["api-linter"];
  #workspacePath?: string;

  #isInstalled = false;
  #isInstallationChecked = false;

  #args: string[] = [];

  constructor(channel: vscode.OutputChannel) {
    this.#channel = channel;
  }

  setCommand(command: string[]) {
    if (command.join(" ") === this.#command.join(" ")) {
      return;
    }
    this.#command = command;
    this.#isInstallationChecked = false;
  }

  setConfigFile(configFile?: string) {
    if (configFile === this.#configFile) {
      return;
    }
    this.#configFile = configFile;
  }

  setProtoPaths(protoPaths: string[]) {
    if (protoPaths.join(",") === this.#protoPaths.join(",")) {
      return;
    }
    this.#protoPaths = protoPaths;
  }

  setDirectories(directories: string[] | null) {
    this.#directories = directories;
  }

  setWorkspacePath(workspacePath: string) {
    this.#workspacePath = workspacePath;
  }

  isInstalled(): boolean {
    if (this.#isInstallationChecked) {
      return this.#isInstalled;
    }
    this.#isInstallationChecked = true;
    const result = cp.spawnSync(
      this.#command[0],
      [...this.#command.slice(1), "-h"],
      { cwd: this.#workspacePath, encoding: "utf-8" }
    );
    return (this.#isInstalled = result.status === 2);
  }

  lint(file: string): vscode.Diagnostic[] {
    let cwd = null;

    if (this.#directories && this.#directories.length) {
      for (const dir of this.#directories) {
        const rel = path.relative(dir, file);
        if (!rel.startsWith('.')) {
          cwd = dir;
          file = rel;
          break;
        }
      }
      if (!cwd) {
        // Skip files that are not located in directories
        return [];
      }
      cwd = path.join(this.#workspacePath!, cwd);
    } else {
      cwd = this.#workspacePath!;
    }

    const args = ["--output-format", "json"];
    if (this.#configFile) {
      args.push("--config", path.relative(cwd, this.#configFile));
    }
    for (const protoPath of this.#protoPaths) {
      args.push("-I", path.relative(cwd, path.join(this.#workspacePath!, protoPath)));
    }

    const result = cp.spawnSync(
      this.#command[0],
      [...this.#command.slice(1), file, ...args],
      { cwd: cwd, encoding: "utf-8" }
    );
    if (result.status !== 0) {
      result.stderr = result.stderr.slice(result.stderr.indexOf(" "));
      result.stderr = result.stderr.slice(result.stderr.indexOf(" "));
      result.stderr = result.stderr.slice(result.stderr.indexOf(" ") + 1);
      return result.stderr
        .split("\n")
        .map((line: string) => {
          if (!line) {
            return;
          }
          const [badFile, lineNo, columnNo, ...descriptionParts] =
            line.split(":");
          const description = descriptionParts.join(":");
          if (file === badFile) {
            return new vscode.Diagnostic(
              new vscode.Range(+lineNo, +columnNo, +lineNo, +columnNo),
              description,
              vscode.DiagnosticSeverity.Error
            );
          }
          return new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, 0),
            description,
            vscode.DiagnosticSeverity.Error
          );
        })
        .filter((value): value is vscode.Diagnostic => value !== undefined);
    }

    const output: Output[] = JSON.parse(result.stdout);
    if (output.length !== 1) {
      return [];
    }

    return output[0].problems.map((p) => {
      const problem = new vscode.Diagnostic(
        toRange(p.location),
        p.message,
        vscode.DiagnosticSeverity.Warning
      );
      problem.code = {
        target: vscode.Uri.parse(p.rule_doc_uri),
        value: p.rule_id,
      };

      return problem;
    });
  }
}
