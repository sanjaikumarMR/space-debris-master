import * as THREE from 'three';

export function draw(vertices, texture, scale) {
    const positions = new Float32Array(vertices.length * 3);
    const colors = new Float32Array(vertices.length * 3);
    for (let i = 0; i < vertices.length; i++) {
        const offset = i * 3;
        positions[offset] = vertices[i][1];
        positions[offset + 1] = vertices[i][2];
        positions[offset + 2] = vertices[i][3];
        colors[offset] = 1;
        colors[offset + 1] = 1;
        colors[offset + 2] = 1;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    const material = new THREE.PointsMaterial({
        map: texture,
        size: Math.max(1, scale * 6),
        sizeAttenuation: true,
        transparent: true,
        alphaTest: 0.1,
        vertexColors: true,
    });
    return new THREE.Points(geometry, material);
}

export function drawPath(scene, xRadius, yRadius, rotationAngle = 0, startAngle = 0, endAngle = 2 * Math.PI, color = 0xff0000) {
    var curve = new THREE.EllipseCurve(
        0, 0,             
        xRadius, yRadius,
        startAngle, endAngle,
        false,
        0         
    );
    var points = curve.getSpacedPoints( 100 );
    var line = new THREE.Line(new THREE.BufferGeometry().setFromPoints( points ), new THREE.LineBasicMaterial({ color: color }));
    line.rotation.y += rotationAngle
    scene.add(line);
}
