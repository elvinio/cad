// ScadPad demo: a parametric rounded box.
// Open the Customizer tab to tweak these values with sliders.

/* [Box] */
// Outer width
width = 40; // [10:100]
// Outer depth
depth = 30; // [10:100]
// Outer height
height = 20; // [5:80]
// Corner radius
radius = 5; // [0.5:0.5:10]

/* [Lid] */
// Cut the box open?
open_top = true;
// Wall thickness
wall = 2; // [1:0.5:6]

/* [Style] */
// Surface finish
style = "rounded"; // [rounded, sharp]

/* [Hidden] */
eps = 0.01;

module shell(w, d, h, r) {
    if (style == "rounded") {
        hull()
            for (x = [r, w - r], y = [r, d - r], z = [r, h - r])
                translate([x, y, z]) sphere(r);
    } else {
        cube([w, d, h]);
    }
}

difference() {
    shell(width, depth, height, radius);
    if (open_top) {
        translate([wall, wall, wall])
            shell(width - 2*wall, depth - 2*wall, height, max(radius - wall, 0.5));
    }
}
