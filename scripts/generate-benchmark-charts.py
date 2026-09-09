# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.11.1"]
# ///
"""Generate the README benchmark charts from a benchmark JSON result."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


IMPLEMENTATIONS = ("line array", "piece tree", "persistent piece tree")
COLORS = ("#6e7781", "#0969da", "#8250df")
DOCUMENTS = (
    ("checker.ts", "checker.ts\n1.46 MB · 27k lines"),
    ("sqlite3.c", "sqlite3.c\n4.31 MB · 128k lines"),
    ("Russian-English Bilingual.dic", "Russian-English\ndictionary\n14.23 MB · 552k lines"),
    ("synthetic huge", "synthetic\n(heap snapshot stand-in)\n54.13 MB · 3.0M lines"),
    ("checker.ts x 128", "checker.ts ×128\n187 MB · 3.4M lines"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", type=Path, help="benchmark JSON produced by npm run bench")
    parser.add_argument("--output", type=Path, default=Path("docs/benchmark"))
    return parser.parse_args()


def configure_style() -> None:
    plt.rcParams.update(
        {
            "axes.edgecolor": "#8c959f",
            "axes.labelcolor": "#57606a",
            "axes.titlecolor": "#24292f",
            "font.family": "sans-serif",
            "font.sans-serif": ["DejaVu Sans", "Arial", "Helvetica"],
            "legend.frameon": False,
            "svg.fonttype": "none",
            "svg.hashsalt": "piece-tree-benchmark",
            "text.color": "#24292f",
            "xtick.color": "#57606a",
            "ytick.color": "#57606a",
        }
    )


def chart(
    medians: dict[tuple[str, str, str], float],
    output: Path,
    filename: str,
    panels: tuple[tuple[str, str, str], ...],
) -> None:
    figure, axes = plt.subplots(
        len(panels),
        1,
        figsize=(10, 3.7 * len(panels)),
        constrained_layout=True,
        squeeze=False,
    )
    x = np.arange(len(DOCUMENTS))
    width = 0.24

    for axis, (title, benchmark, unit) in zip(axes[:, 0], panels):
        for index, (implementation, color) in enumerate(zip(IMPLEMENTATIONS, COLORS)):
            values = [
                medians[(document, benchmark, implementation)]
                / (1024 * 1024 if unit == "MiB" else 1)
                for document, _ in DOCUMENTS
            ]
            axis.bar(
                x + (index - 1) * width,
                values,
                width,
                color=color,
                label=implementation,
            )
        axis.set_title(title, loc="left", fontsize=12, fontweight="bold")
        axis.set_ylabel(unit)
        axis.set_yscale("log")
        axis.set_xticks(x, [label for _, label in DOCUMENTS], fontsize=8)
        axis.grid(axis="y", which="both", color="#d8dee4", linewidth=0.6)
        axis.set_axisbelow(True)
        axis.spines[["top", "right"]].set_visible(False)

    handles, labels = axes[0, 0].get_legend_handles_labels()
    figure.legend(handles, labels, loc="outside upper center", ncols=3)
    output.mkdir(parents=True, exist_ok=True)
    figure.savefig(output / filename, format="svg", metadata={"Date": None})
    plt.close(figure)


def main() -> None:
    args = parse_args()
    data = json.loads(args.results.read_text())
    medians = {
        (result["document"], result["benchmark"], result["implementation"]): result["median"]
        for result in data["results"]
    }
    configure_style()

    chart(medians, args.output, "memory.svg", ((
        "Retained heap after loading",
        "Memory usage after load",
        "MiB",
    ),))
    chart(medians, args.output, "file-opening.svg", ((
        "Build buffer from 64 KB file chunks",
        "File opening",
        "ms",
    ),))
    chart(
        medians,
        args.output,
        "editing.svg",
        (
            ("Apply 1000 random edits", "Editing: 1000 random edits", "ms"),
            ("Apply 1000 sequential end inserts", "Editing: 1000 sequential inserts", "ms"),
        ),
    )
    chart(
        medians,
        args.output,
        "reading.svg",
        (
            ("Read every line after 1000 random edits", "Reading: all lines after 1000 random edits", "ms"),
            (
                "Read 10 windows of 100 lines after 1000 random edits",
                "Reading: 10 windows of 100 lines after 1000 random edits",
                "ms",
            ),
        ),
    )
    chart(
        medians,
        args.output,
        "saving.svg",
        (
            ("Read full text after 1000 random edits", "Saving: full text after 1000 random edits", "ms"),
            (
                "Read full text after 1000 sequential end inserts",
                "Saving: full text after 1000 sequential inserts",
                "ms",
            ),
        ),
    )
    chart(
        medians,
        args.output,
        "undo.svg",
        (
            ("Undo 1000 random edits", "Undo: 1000 random edits, one by one", "ms"),
            ("Undo 1000 sequential end inserts", "Undo: 1000 sequential inserts, one by one", "ms"),
        ),
    )
    chart(
        medians,
        args.output,
        "redo.svg",
        (
            ("Redo 1000 random edits", "Redo: 1000 random edits, one by one", "ms"),
            ("Redo 1000 sequential end inserts", "Redo: 1000 sequential inserts, one by one", "ms"),
        ),
    )
    chart(
        medians,
        args.output,
        "history-memory.svg",
        (
            ("Memory after 1000 random edits", "Memory after 1000 random edits", "MiB"),
            (
                "Memory after 1000 random edits with undo history",
                "Memory after 1000 random edits with undo history",
                "MiB",
            ),
        ),
    )


if __name__ == "__main__":
    main()
